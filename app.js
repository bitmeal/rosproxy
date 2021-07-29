const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const xrpc = require('xrpc');
// const XmlRpcParser = require('xrpc/lib/xmlrpc-parser');
const XmlRpcMessage = require('xrpc/lib/xmlrpc-message');
const XmlRpcResponse = require('xrpc/lib/xmlrpc-response');
const XmlRpcFault = require('xrpc/lib/xmlrpc-fault');
const Url = require('url-parse');
const urljoin = require('url-join');
const os = require('os');
const getPort = require('get-port');
const proxy = require("node-tcp-proxy");

// TODO: make configurable and read ENV!
const proxyPort = 33133;
const ROSHostname = os.hostname(); // use ROS_HOSTNAME
const ROSMasterURI = 'http://localhost:11311'; // use ROS_MASTER_URI
const portTCPmin = 30000
const portTCPmax = 31000

// xrpc fault codes: http://xmlrpc-epi.sourceforge.net/specs/rfc.fault_codes.php
const failurePath = '/fault';
const failureTarget = urljoin('http:', `localhost:${proxyPort}`, failurePath); //-32500 application error


const app = express();
app.use(xrpc.xmlRpc);

// could not resolve target; failure application error
app.use(failurePath, (req, res) => {
    // res.type('text/xml');
    // res.send(new XmlRpcFault(-32500, 'Could not resolve endpoint to proxy to!').xml().replace(/<(\/?)i4>/g, '<\$1int>'));
    res.sendStatus(404);
})


// proxy router, populated dynamically
// resolve proxy path to node endpoint
var nodeRouter = {}

// resolve node endpoint to proxy path
function xrpcProxyPath(xrpcpath) {
    ({ hostname, port } = new Url(xrpcpath));
    id = `${hostname}${port}`.replace(/\W/g, '');
    
    if(hostname && port) {
        proxyPath = `/node/${id}`;
        nodeRouter[proxyPath] = xrpcpath;

        // console.log('lookup xrpc proxy:', xrpcpath, '-->', proxyPath); // no lookup here...
        return proxyPath;
    }

    return null;
}


// resolve TCPROS address + port and rosrpc://address:port to local proxy port
var TCPROSRouter = {} // { port: <port>, proxy: <proxy> }
async function resolveTCPROSPort(hostname, port) {
    id = `${hostname}${port}`.replace(/\W/g, '');
    if(!TCPROSRouter[id]) {
        let proxyPort = await getPort();
        console.log('creating new proxy to', `${hostname}:${port}`, 'on port', proxyPort);
        
        let proxyInstance = proxy.createProxy(proxyPort, hostname, port); //, { tls: false, hostname: '0.0.0.0' });
        
        TCPROSRouter[id] = { port: proxyPort, proxy: proxyInstance };
    }
    
    return TCPROSRouter[id].port;
}

async function TCPROSProxyPort(hostname, port) {
    if(hostname && port) {
        return resolveTCPROSPort(hostname, port);
    }
    else {
        return null;
    }
}

async function rosrpcProxyPort(rosrpcurl) {
    ({ protocol, hostname, port } = new Url(rosrpcurl));

    if(protocol != 'rosrpc:') {
        console.error('rosrpc address does not have protocol "rosrpc:"; has', protocol);
        return null;
    }

    return TCPROSProxyPort(hostname, port);
}



// master API (node --> master)
function rewriteCallerAPI(xreq) {
    const callerAPIPos = {
        registerService: 3,
    
        registerSubscriber: 3,
        unregisterSubscriber: 2,
    
        registerPublisher: 3,
        unregisterPublisher: 2
    };
    
    idx = callerAPIPos[xreq.method || xreq.methodName]; // methodName on system.multicall

    if(idx) {
        let callerAPI = xrpcProxyPath(xreq.params[idx]);
        if(callerAPI) {
            callerAPI = urljoin('http://', `${ROSHostname}:${proxyPort}`, callerAPI);
            console.log('Rewriting caller API:', xreq.params[idx], 'as', callerAPI);
            xreq.params[idx] = callerAPI;
        }
        else {
            console.error('Could not rewrite caller API for: ', xreq);
        }
    }
}

async function rewriteROSRPC(xreq) {
    const idx = 2;
    let method = xreq.method || xreq.methodName; // methodName on system.multicall
    if(method == 'registerService' || method == 'unregisterService') {
        let rosrpcPort = await rosrpcProxyPort(xreq.params[idx]);
        rosrpcEndpoint = urljoin('rosrpc://', `${ROSHostname}:${rosrpcPort}`);
        console.log('Rewriting rosrpc:// endpoint:', xreq.params[idx], 'as', rosrpcEndpoint);
        xreq.params[idx] = rosrpcEndpoint;
    }
}

app.use('/master',
    async (req, _res, next) => {
        if(req.body_XMLRPC) {
            let xrpcRewriteTargets = req.body_XMLRPC.method == 'system.multicall' ? req.body_XMLRPC.params[0] : [req.body_XMLRPC];
            
            xrpcRewriteTargets.forEach((m) => { rewriteCallerAPI(m); });
            await Promise.all(xrpcRewriteTargets.map((m) => rewriteROSRPC(m)));
            // rewriteCallerAPI(req.body_XMLRPC);
            // await rewriteROSRPC(req.body_XMLRPC);
        }
        next();
    },
    createProxyMiddleware({
        target: ROSMasterURI,
        pathRewrite: {
            '^/.*': '/'
        },
        changeOrigin: true,
        autoRewrite: true,
        protocolRewrite: true,

        onProxyReq(proxyReq, req, _res) {
            if (req.method == 'POST' && req.body_XMLRPC) {
                // console.log(req.body_XMLRPC);
                if(req.body_XMLRPC.method == 'system.multicall') {
                    req.body_XMLRPC.params[0].forEach((m) => { console.log(m); });
                }
                if (req.body) delete req.body;
                let xrpcMsg = new XmlRpcMessage(req.body_XMLRPC.method, req.body_XMLRPC.params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(xrpcMsg));
                proxyReq.write(xrpcMsg);
                proxyReq.end();
            }
        }
    })
);

// node API (node/master --> node)
function rewriteTopicProtocols(xreq) {
    const idx = 2;
    if(Array.isArray(xreq.params[2]) && xreq.params[2].map(p => p[0]).includes('TCPROS')) {
        xreq.params[2] = [['TCPROS']];
        console.log('requestTopic: rewriting accepted protocols to TCPROS only');
        return true;
    }
    else {
        console.error('requestTopic: protocols does not include TCPROS:', xreq.params[2]);
        return false;
    }
}

async function rewriteTopicEndpoint(xreq) {
    let [protocol, hostname, port] = xreq.params[0][2];
    let tcprosPort = await resolveTCPROSPort(hostname, port);
    let tcprosHost = ROSHostname;
    console.log('Rewriting TCPROS connection details for topic;', `${hostname}:${port}`, 'as', `${tcprosHost}:${tcprosPort}`);
    xreq.params[0][2] = [protocol, tcprosHost, tcprosPort];
}

const nodeProxyCommon = {
    target: failureTarget,
    pathRewrite: {
        '^/.*': '/'
    },
    router: nodeRouter,
    changeOrigin: true,
    autoRewrite: true,
    protocolRewrite: true,
    onProxyReq(proxyReq, req, res) {
        if (req.method == 'POST' && req.body_XMLRPC) {
            if (req.body) delete req.body;
            let xrpcMsg = new XmlRpcMessage(req.body_XMLRPC.method, req.body_XMLRPC.params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(xrpcMsg));
            proxyReq.write(xrpcMsg);
            proxyReq.end();
        }
    },
}

const nodeSimpleProxy = createProxyMiddleware(nodeProxyCommon);
const nodeTopicReqProxy = createProxyMiddleware(Object.assign({}, nodeProxyCommon,
    {
        selfHandleResponse: true, // modify response; IMPORTANT: res.end() is called internally by responseInterceptor()
        onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            // prepare body for xmlrpc middleware
            proxyRes.rawBody = responseBuffer; //.toString('utf8');
            await new Promise((resolve) => {
                xrpc.xmlRpc(proxyRes, {}, resolve);
            });

            // this proxy should only handle topicRequest responses
            if(proxyRes.body_XMLRPC && !proxyRes.body_XMLRPC.is_fault) {
                let xrpcres = proxyRes.body_XMLRPC;
                // console.log('xrpc response:', xrpcres);
                
                if(!xrpcres.params[0] || xrpcres.params[0].length != 3 || !Array.isArray(xrpcres.params[0][2])) {
                    console.log('Node sent response with unexpected parameters for topicRequest!');
                    return new XmlRpcFault(-32500, 'Node sent response with unexpected parameters!').xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                }

                await rewriteTopicEndpoint(xrpcres);
                // hack deserialization error: force array element 0 of return values to number type
                xrpcres.params[0][0] = Number(xrpcres.params[0][0]);

                return new XmlRpcResponse(xrpcres.params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
            }
            else {
                // response is no valid response to topicRequest
                return responseBuffer;
            }
        }),
    }
));

app.use(
    '/node',
    async (req, res, next) => {
        if(req.body_XMLRPC && req.body_XMLRPC.method == 'requestTopic') {
            if(rewriteTopicProtocols(req.body_XMLRPC)) {
                await nodeTopicReqProxy(req, res, next);
            }
            else {
                res.type('text/xml');
                res.send(new XmlRpcFault(-32500, 'Can proxy TCPROS connections only!').xml().replace(/<(\/?)i4>/g, '<\$1int>'));            
            }
        }
        else {
            await nodeSimpleProxy(req, res, next);
        }
    }
);

// run server
app.listen(proxyPort);

