const getPort = require('get-port');
const TCPProxy = require('node-tcp-proxy');
const Url = require('url-parse');
const urljoin = require('url-join');
const zip = require('zip-array').zip;
//const unzip = require('unzip-array');
const XmlRpcResponse = require('xrpc/lib/xmlrpc-response');



class NodeProxy {
    constructor(id, xrpcAddress, proxyHostname, xrpcProxy, xrpcNodeAPIBasePath, proxyGenerator) {
        this.proxyHostname = proxyHostname;
        this.proxyGenerator = proxyGenerator;
        
        this.id = id;

        this.xrpcAddress = xrpcAddress;
        this.xrpcProxy = xrpcProxy;

        this.xrpcNodeAPIBasePath = xrpcNodeAPIBasePath;
        // this.xrpcPort = xrpcProxy.proxyPort;

        //this.hostname = null;
        this.TCPROSProxies = {}; // { <hostname><port>: <proxy> }

        this.subscriptions = [];
        this.publications = [];
        this.services = [];
    }

    removeFirstFromList(list, elem) {
        let idx = list.findIndex(e => e == elem);
        if(idx != -1) {
            list.splice(idx, 1);
        }
    }

    nodeAPIXrpcProxyPath() {
        return `${this.xrpcNodeAPIBasePath}/${this.id}`;
    }

    getCallerAPI() {
        return urljoin('http://', `${this.proxyHostname}:${this.xrpcProxy.proxyPort}`, this.nodeAPIXrpcProxyPath());
    }

    async getTCPROSProxyInfo(hostname, port) {
        let id = `${hostname}${port}`.replace(/\W/g, '');
        if(this.TCPROSProxies[id]) {
            return [this.proxyHostname, this.TCPROSProxies[id].proxyPort];
        }
        else {
            // make new proxy
            let TCPROSProxy = await this.proxyGenerator(hostname, port);
            this.TCPROSProxies[id] = TCPROSProxy;
            return [this.proxyHostname, TCPROSProxy.proxyPort];
        }
    }

    async getRosrpcProxy(rosrpcurl) {
        let uri = new Url(rosrpcurl);
        let [rosrpcHostname, rosrpcPort] = await this.getTCPROSProxyInfo(uri.hostname, uri.port);
        
        return urljoin('rosrpc://', `${rosrpcHostname}:${rosrpcPort}`);
    }
    
    caller_api_ok(caller_api) {
        // TODO: throw?
        if(caller_api != this.xrpcAddress) {
            console.error('Caller XRPC APIs for node', this.id, 'do not match:', caller_api, '<--->', this.xrpcAddress);
            return false;
        }
        else {
            return true;
        }
    }

    // MASTER API
    //method calls
    async registerService(service, service_api, caller_api) {
        // TODO: check caller api
        this.services.push(service);

        caller_api = this.getCallerAPI();
        service_api = (await this.getRosrpcProxy(service_api));
        return [service, service_api, caller_api];
    }

    async unregisterService(service, service_api) {
        this.removeFirstFromList(this.services, service);

        service_api = (await this.getRosrpcProxy(service_api));
        return [service, service_api];
    }
    
    registerSubscriber(topic, _topic_type, caller_api) {
        // TODO: check caller api
        this.subscriptions.push(topic);

        caller_api = this.getCallerAPI();
        return [topic, _topic_type, caller_api];
    }

    unregisterSubscriber(topic, caller_api) {
        this.removeFirstFromList(this.subscriptions, topic);

        caller_api = this.getCallerAPI();
        return [topic, caller_api];
    }

    registerPublisher(topic, _topic_type, caller_api) {
        // TODO: check caller api
        this.publications.push(topic);

        caller_api = this.getCallerAPI();
        return [topic, _topic_type, caller_api];
    }

    unregisterPublisher(topic, caller_api) {
        this.removeFirstFromList(this.publications, topic);

        caller_api = this.getCallerAPI();
        return [topic, caller_api];
    }

    // NODE API
    // method calls
    requestTopic(_topic, protocols) {
        // rewrite protocols to TCPROS only
        return [_topic, protocols.filter(p => p[0] == 'TCPROS')];
    }

    // method responses
    async requestTopicResponse(protocolParams) {
        if(protocolParams.length) {
            let [protocol, topicHostname, topicPort] = protocolParams;
            if(protocol == 'TCPROS') {
                let [hostname, port] = await this.getTCPROSProxyInfo(topicHostname, topicPort);
                return [protocol, hostname, port];
            }
            else {
                // should never happen, as accepted protocols are rewritten to TCPROS only
                console.error('Node responded with accepted protocol other than TCPROS!', protocolParams);
                return [];
            }
        }
        else {
            return protocolParams;
        }
    }

    // returns modified request; should leave original request intact
    async processMethodCall(xrpcreq) {
        let method = xrpcreq.method || xrpcreq.methodName;

        // if(method == 'system.multicall') {
        //     return Object.assign({},
        //         xrpcreq,
        //         {
        //             params: [
        //                 await Promise.all(
        //                     xrpcreq.params[0].map((r) => {
        //                         return this.processMethodCall(r);
        //                     })
        //                 )
        //             ]
        //         }
        //     );
        // }
        // else
        // system.multicall processing offloaded to NodeProxyManager
        if(this[method]) {
            // remove caller_id (node name) and get copy to preserve original data
            let params = await this[method](...xrpcreq.params.slice(1));
            return Object.assign({},
                xrpcreq,
                { params: [xrpcreq.params[0], ...params] }
            )
        }
        else {
            return xrpcreq;
        }
    }

    // returns modified response; should leave original response intact
    async processMethodResponse(xrpcreq, xrpcresp) {
        let method = `${xrpcreq.method || xrpcreq.methodName}Response`;
        if(this[method]) {
            // remove status code and message, and get copy to preserve original data
            let retval = await this[method](xrpcresp.params[0].slice(-1)[0]);

            // assign new response parameter array
            return Object.assign({},
                xrpcresp,
                { params: [[...xrpcresp.params[0].slice(0, -1), retval]] }
            )
        }
        else {
            return xrpcresp;
        }        
    }
}

// make node representation with instantiated xrpc proxy and configured proxy generator
class NodeProxyFactory {
    constructor(xrpcNodeAPIBasePath, proxyHostname, xrpcProxyPort, options = {}) {
        this.xrpcNodeAPIBasePath = xrpcNodeAPIBasePath;
        this.proxyHostname = proxyHostname;
        this.xrpcProxyPort = xrpcProxyPort;
        this.getPortOpts = {};

        if(options) {
            if(options.portMin && options.portMax) {
                this.getPortOpts = {
                    port: getPort.makeRange(options.portMin, options.portMax)
                }
            }
            else if(Array.isArray(options) && options.length == 2) {
                this.getPortOpts = {
                    port: getPort.makeRange(options[0], options[1])
                }
            }
            else {
                console.log('Use { portMin: <min>, portMax: <max> }, or [<min>, <max>] for options');
            }
        }
    }

    async makeProxy(hostname, port) {
        let proxyPort = await getPort(this.getPortOpts);
        return TCPProxy.createProxy(proxyPort, hostname, port);
    }

    async makeNode(id, xrpcAddress) {
        let xrpcProxy = await this.makeProxy('localhost', this.xrpcProxyPort);
        // id, xrpcAddress, proxyHostname, xrpcProxy, xrpcNodeAPIBasePath, proxyGenerator
        return new NodeProxy(id, xrpcAddress, this.proxyHostname, xrpcProxy, this.xrpcNodeAPIBasePath, this.makeProxy);
    }
}

class NodeProxyManager {
    constructor(proxyHostname, xrpcProxyPort, xrpcNodeAPIBasePath, options = {}) {
        this.sanitizerRe = /(^\/*)|(\/*$)/g;

        this.options = options; // use for nodeFactory only

        // sanitize base path as '/pa/th'; (leading, no trailing /)
        this.xrpcNodeAPIBasePath = `/${xrpcNodeAPIBasePath.replace(this.sanitizerRe, '')}`;
        this.proxyHostname = proxyHostname;
        this.xrpcProxyPort = xrpcProxyPort;

        this.nodeFactory = new NodeProxyFactory(this.xrpcNodeAPIBasePath, this.proxyHostname, this.xrpcProxyPort, this.options);
        
        this.proxyNodes = {};
    }

    sanitizeNodeId(id) {
        return id.replace(this.sanitizerRe, '');
    }
    
    nodeIdFromNodeAPIXrpcPath(path) {
        return path.replace(this.xrpcNodeAPIBasePath, '').replace(this.sanitizerRe, '');
    }

    // nodeAPIXrpcPathFromNodeId(id) {
    //     return `${this.xrpcNodeAPIBasePath}/${id}`;
    // }

    getXrpcAddressFromReqest(xrpcreq) {
        const callerAPIPos = {
            registerService: 3,
        
            registerSubscriber: 3,
            unregisterSubscriber: 2,
        
            registerPublisher: 3,
            unregisterPublisher: 2
        };
        
        let idx = callerAPIPos[(xrpcreq.method || xrpcreq.methodName)] || -1;
        return idx == -1 ? null : xrpcreq.params[idx];
    }

    // creates new node if neccessary
    async getXrpcReqSourceNode(xrpcreq) {
        let id = this.sanitizeNodeId(xrpcreq.params[0]);
        
        // construct node if unknown
        if(!this.proxyNodes[id]) {
            let xrpcAddress = this.getXrpcAddressFromReqest(xrpcreq);

            if(!xrpcAddress) {
                // must have been unregisterService; should never happen as first seen call
                // console.error('Could not get nodes xrpc address from MASTER API request!');
                console.log('Unhandled xrpc request:', xrpcreq.method || xrpcreq.methodName);
                return null;
            }

            console.log('creating new nodeProxy instance for id:', id);
            let node = await this.nodeFactory.makeNode(id, xrpcAddress);
            this.proxyNodes[id] = node;
        }
        
        return this.proxyNodes[id];
    }

    // nodes should be availabe, as no proxy to reach endpoint would be available otherwise
    getXrpcReqTargetNode(xrpcPath) {
        let id = this.nodeIdFromNodeAPIXrpcPath(xrpcPath);
        return this.proxyNodes[id];
    }


    // node-http-proxy router function
    xrpcRouter(req) {
        let node = this.getXrpcReqTargetNode(req.path);
        return node && node.xrpcAddress;
    }

    // param 0 gets parsed as string --> explicitly make number
    fixXrpcResponseSerialization(xrpcresp) {
        if(
            !xrpcresp.is_fault &&
            xrpcresp.params[0] &&
            xrpcresp.params[0].length == 3 &&
            Number(xrpcresp.params[0][0]) != NaN
        ) {
            xrpcresp.params[0][0] = Number(xrpcresp.params[0][0]);
        }

        return xrpcresp;
    }

    async handleMulticall(targetFn, xrpcreq , xrpcresp) {
        // handle requests only
        if(!xrpcresp) {
            return Object.assign({},
                xrpcreq,
                {
                    params: [
                        await Promise.all(
                            xrpcreq.params[0].map((r) => {
                                return targetFn(r);
                            })
                        )
                    ]
                }
            );
        }
        // handle responses
        else {
            return Object.assign({},
                xrpcresp,
                {
                    params: [[
                        (await Promise.all(
                            zip(xrpcreq.params[0], xrpcresp.params[0][0])
                            .map(([xreq, xresp]) => {
                                // return targetFn(xreq, new XmlRpcResponse([xresp]))
                                return targetFn(xreq, { params: [xresp] })
                            })
                        )).map(xresp => xresp.params[0])
                    ]]
                }
            );
        }
    }

    // MASTER API includes caller_id as proxy node identifier
    // returns modified request; should leave original request intact
    async processMasterAPIMethodCall(xrpcreq) {
        if((xrpcreq.method || xrpcreq.methodName) == 'system.multicall') {
            return await this.handleMulticall(
                (xreq) => { return this.processMasterAPIMethodCall(xreq); }, xrpcreq
            );
        }
        else {
            let nodeProxy = await this.getXrpcReqSourceNode(xrpcreq);
            return nodeProxy ? await nodeProxy.processMethodCall(xrpcreq) : xrpcreq;
        }
    }

    // returns modified response; should leave original response intact
    async processMasterAPIMethodResponse(xrpcreq, xrpcresp) {
        if((xrpcreq.method || xrpcreq.methodName) == 'system.multicall') {
            return await this.handleMulticall(
                (xreq, xres) => { return this.processMasterAPIMethodResponse(xreq, xres); }, xrpcreq, xrpcresp
            );
        }
        else {
            let nodeProxy = await this.getXrpcReqSourceNode(xrpcreq);
            return nodeProxy ?
                this.fixXrpcResponseSerialization(
                    await nodeProxy.processMethodResponse(xrpcreq, xrpcresp)
                ) :
                xrpcreq;
        }
    }

    // NODE API, uses xrpc proxy path as node identifier
    // returns modified request; should leave original request intact
    async processNodeAPIMethodCall(xrpcPath, xrpcreq) {
        if((xrpcreq.method || xrpcreq.methodName) == 'system.multicall') {
            return await this.handleMulticall(
                async (r) => { return await this.processNodeAPIMethodCall(xrpcPath, r)},
                xrpcreq
            );
        }
        else {
            return await (
                await this.getXrpcReqTargetNode(xrpcPath)
            ).processMethodCall(xrpcreq);
        }
    }

    // returns modified response; should leave original response intact
    async processNodeAPIMethodResponse(xrpcPath, xrpcreq, xrpcresp) {
        //TODO: handle multicall responses
        if((xrpcreq.method || xrpcreq.methodName) == 'system.multicall') {
            return await this.handleMulticall(
                async (xreq, xresp) => { return await this.processNodeAPIMethodResponse(xrpcPath, xreq, xresp)},
                xrpcreq,
                xrpcresp
            );
        }
        else {
            return this.fixXrpcResponseSerialization(
                await (
                    await this.getXrpcReqTargetNode(xrpcPath)
                ).processMethodResponse(xrpcreq, xrpcresp)
            );
        }
    }

    async doHousekeeping() {
        console.log('Running housekeeping...');

        Object.keys(this.proxyNodes)
        .forEach((n) => {
            let node = this.proxyNodes[n];
            if((node.subscriptions + node.publications + node.services) == 0) {
                console.log('Cleaning up dead node', node.id);
                
                console.log('\tStopping TCPROS proxies...');
                Object.values(node.TCPROSProxies)
                .forEach((p) => {
                    p.end();
                })
                
                console.log('\tStopping XMLRPC proxy...');
                node.xrpcProxy.end();

                delete this.proxyNodes[n];
            }
        })
    }

    enableHousekeeping(rate_ms = 5000) {
        setTimeout(() => {
            this.doHousekeeping();
            this.enableHousekeeping(rate_ms);
        }, rate_ms);
    }
}


/////////////////////////////////////////

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const xrpc = require('xrpc');
const XmlRpcMessage = require('xrpc/lib/xmlrpc-message');
//const XmlRpcResponse = require('xrpc/lib/xmlrpc-response');
const XmlRpcFault = require('xrpc/lib/xmlrpc-fault');
//const Url = require('url-parse');
//const urljoin = require('url-join');
const os = require('os');


// TODO: make configurable and read ENV!
const proxyPort = 33133;
const ROSHostname = os.hostname(); // use ROS_HOSTNAME
const ROSMasterURI = 'http://localhost:11311'; // use ROS_MASTER_URI
//const portTCPmin = 30000
//const portTCPmax = 31000

const nodeAPIBasePath = '/node';

// xrpc fault codes: http://xmlrpc-epi.sourceforge.net/specs/rfc.fault_codes.php
const failurePath = '/fault';
const failureTarget = urljoin('http:', `localhost:${proxyPort}`, failurePath); //-32500 application error


const proxyManager = new NodeProxyManager(ROSHostname, proxyPort, nodeAPIBasePath);

const app = express();
app.use(xrpc.xmlRpc);

// could not resolve target; failure application error
app.use(failurePath, (req, res) => {
    res.type('text/xml');
    res.send(new XmlRpcFault(-32500, 'Could not resolve endpoint to proxy to!').xml().replace(/<(\/?)i4>/g, '<\$1int>'));
})


const xrpcHttpProxyCommon = {
    pathRewrite: {
        '^/.*': '/'
    },
    changeOrigin: true,
    autoRewrite: true,
    protocolRewrite: true,

    onProxyReq(proxyReq, req, _res) {
        if (req.method == 'POST' && req.body_XMLRPC) {
            if (req.body) delete req.body;
            let xrpcMsg = new XmlRpcMessage(req.body_XMLRPC.method, req.body_XMLRPC.params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(xrpcMsg));
            proxyReq.write(xrpcMsg);
            proxyReq.end();
        }
    }
}
// MASTER API
app.use('/master',
    async (req, _res, next) => {
        if(req.body_XMLRPC) {
            req.body_XMLRPC = (await proxyManager.processMasterAPIMethodCall(req.body_XMLRPC));
        }
        next();
    },
    createProxyMiddleware(
        Object.assign({},
            xrpcHttpProxyCommon,
            { target: ROSMasterURI }
        )
    )
);

// NODE API
// let responseProcessor = async (...params) => { return await proxyManager.processNodeAPIMethodResponse(...params); };
// return new XmlRpcResponse(
//     (await responseProcessor(req.path, req.body_XMLRPC, xrpcres)).params
// ).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');

app.use(nodeAPIBasePath,
    async (req, _res, next) => {
        if(req.body_XMLRPC) {
            req.body_XMLRPC = (await proxyManager.processNodeAPIMethodCall(req.originalUrl, req.body_XMLRPC));
        }
        next();
    },
    createProxyMiddleware(
        Object.assign({},
            xrpcHttpProxyCommon,
            {
                target: failureTarget,
                router: (req) => proxyManager.xrpcRouter(req),
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

                        if(!xrpcres.params[0] || xrpcres.params[0].length != 3) {
                            console.error('Node sent response with unexpected parameters:', xrpcres);
                            return new XmlRpcFault(-32500, 'Node sent response with unexpected parameters!').xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                        }
        
                        return new XmlRpcResponse((await proxyManager.processNodeAPIMethodResponse(req.originalUrl, req.body_XMLRPC, xrpcres)).params).xml();//.replace(/<(\/?)i4>/g, '<\$1int>');
                    }
                    else {
                        return responseBuffer;
                    }
                }),
            }
        )
    )
);

// run server
app.listen(proxyPort);
console.log('Enabling automatic housekeeping');
proxyManager.enableHousekeeping();
