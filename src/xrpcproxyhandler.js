const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const xrpc = require('xrpc');
const XmlRpcMessage = require('xrpc/lib/xmlrpc-message');
const XmlRpcResponse = require('xrpc/lib/xmlrpc-response');
const XmlRpcFault = require('xrpc/lib/xmlrpc-fault');
const urljoin = require('url-join');

const log = require('loglevel')//.getLogger('XRPCProxyHandler');
const logHttpProxyMiddleware = () => { return log.getLogger('HPM'); };


function makeXRPCProxyHandler(ROSMasterURI, proxyManager, options) {
    const logXRPCProxyHandler = log.getLogger('XRPCProxyHandler');

    const _options = Object.assign({
            failurePath: '/fault',
            masterAPIBasePath: '/master',
            nodeAPIBasePath: proxyManager.xrpcNodeAPIBasePath,
            proxyPort: proxyManager.xrpcProxyPort,
            ROSMasterURI: ROSMasterURI,
        },
        options
    );

    logXRPCProxyHandler.debug(`XRPCProxyHandler options: ${JSON.stringify(_options)}`);
    logXRPCProxyHandler.debug(`XRPCProxyHandler for ROS master @ ${ROSMasterURI}`);

    // xrpc fault codes: http://xmlrpc-epi.sourceforge.net/specs/rfc.fault_codes.php
    if(!_options.failureTarget) {
        _options.failureTarget = urljoin('http:', `localhost:${_options.proxyPort}`, _options.failurePath); //-32500 application error
    }
    logXRPCProxyHandler.info(`Serving default route as FAILURE from ${_options.failurePath} (${_options.failureTarget})`);

    const app = express();
    app.use(xrpc.xmlRpc);

    // could not resolve target; failure application error
    app.use(_options.failurePath, (req, res) => {
        logXRPCProxyHandler.warn('Something redirected to our failure target; node registration info may be stale. Enable automatic housekeeping or increase its frequency.');
        res.type('text/xml');
        res.send(new XmlRpcFault(-32500, 'Could not resolve endpoint to proxy to!').xml());//.replace(/<(\/?)i4>/g, '<\$1int>'));
    })


    const xrpcHttpProxyCommon = {
        pathRewrite: {
            '^/.*': '/'
        },
        changeOrigin: true,
        autoRewrite: true,
        protocolRewrite: true,

        logProvider: (_provider) => {
            return logHttpProxyMiddleware();
        },

        onProxyReq(proxyReq, req, _res) {
            if (req.method == 'POST' && req.body_XMLRPC) {
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Serializing XRPC message ${JSON.stringify(req.body_XMLRPC)}`);
                if (req.body) {
                    //log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Removing original message body: ${req.body}`);
                    delete req.body;
                }
                let xrpcMsg = new XmlRpcMessage(req.body_XMLRPC.method, req.body_XMLRPC.params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Serialized as ${xrpcMsg.replace(/\n/g, '')}`);
                //log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Setting Content-Length header as ${Buffer.byteLength(xrpcMsg)}`);
                proxyReq.setHeader('Content-Length', Buffer.byteLength(xrpcMsg));
                proxyReq.write(xrpcMsg);
                proxyReq.end();
            }
        }
    }

    // MASTER API
    app.use(_options.masterAPIBasePath,
        async (req, _res, next) => {
            if(req.body_XMLRPC) {
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Processing XRPC request to Master-API`);
                req.body_XMLRPC = (await proxyManager.processMasterAPIMethodCall(req.body_XMLRPC));
            }
            else {
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).warn(`Got non-XRPC request to Master-API: [${req.method}] - body: ${(req.body || (req.rawBody && req.rawBody.toString('utf-8'))).replace(/\n/g, '\\n')}`);
            }
            next();
        },
        createProxyMiddleware(
            Object.assign({},
                xrpcHttpProxyCommon,
                { target: _options.ROSMasterURI }
            )
        )
    );

    // NODE API
    app.use(_options.nodeAPIBasePath,
        async (req, _res, next) => {
            if(req.body_XMLRPC) {
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Processing XRPC request to Slave-API`);
                req.body_XMLRPC = (await proxyManager.processNodeAPIMethodCall(req.originalUrl, req.body_XMLRPC));
            }
            else {
                log.getLogger(`XRPCProxy [${req.originalUrl}]`).warn(`Got non-XRPC request to Slave-API: [${req.method}] - body: ${(req.body || (req.rawBody && req.rawBody.toString('utf-8'))).replace(/\n/g, '\\n')}`);
            }
            next();
        },
        createProxyMiddleware(
            Object.assign({},
                xrpcHttpProxyCommon,
                {
                    target: _options.failureTarget,
                    router: (req) => proxyManager.xrpcRouter(req),
                    selfHandleResponse: true, // modify response; IMPORTANT: res.end() is called internally by responseInterceptor()
                    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
                        // prepare body for xmlrpc middleware
                        proxyRes.rawBody = responseBuffer; //.toString('utf8');
                        log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Got response from node; body: ${responseBuffer ? responseBuffer.toString('utf-8').replace(/\n/g, '\\n') : '<empty>'}`);

                        await new Promise((resolve) => {
                            xrpc.xmlRpc(proxyRes, {}, resolve);
                        });
            
                        // this proxy should only handle topicRequest responses
                        if(proxyRes.body_XMLRPC && !proxyRes.body_XMLRPC.is_fault) {
                            let xrpcResp = proxyRes.body_XMLRPC;
                            log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`XRPC response: ${JSON.stringify(xrpcResp)}`);

                            if(!xrpcResp.params[0] || xrpcResp.params[0].length != 3) {
                                log.getLogger(`XRPCProxy [${req.originalUrl}]`).error(`Node sent response with unexpected parameters: ${JSON.stringify(xrpcResp)}`);
                                return new XmlRpcFault(-32500, 'Node sent response with unexpected parameters!').xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                            }
            
                            let xrpcRespParams = (await proxyManager.processNodeAPIMethodResponse(req.originalUrl, req.body_XMLRPC, xrpcResp)).params;
                            log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Rewrote parameters to: ${JSON.stringify(xrpcRespParams)}`);
                            let xrpcRespXml = new XmlRpcResponse(xrpcRespParams).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                            log.getLogger(`XRPCProxy [${req.originalUrl}]`).debug(`Sending proxied response; body: ${xrpcRespXml.replace(/\n/g, '')}`);
                            return xrpcRespXml;
                        }
                        else {
                            log.getLogger(`XRPCProxy [${req.originalUrl}]`).warn(`Is no valid XRPC response`)
                            return responseBuffer;
                        }
                    }),
                }
            )
        )
    );

    return app;
}

module.exports = makeXRPCProxyHandler;