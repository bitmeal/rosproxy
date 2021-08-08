const NodeProxyFactory = require('./nodeproxy');

const zip = require('zip-array').zip;
// const got = require('got');
// const xrpc = require('xrpc');
const uXRPC = require('./uxrpc');

const XmlRpcResponse = require('xrpc/lib/xmlrpc-response');
const XmlRpcMessage = require('xrpc/lib/xmlrpc-message');

const log = require('loglevel');


class NodeProxyManager {
    constructor(proxyHostname, xrpcProxyPort, xrpcNodeAPIBasePath, options = {}) {
        this.log = log.getLogger(`<${this.constructor.name}>`);


        this.sanitizerRe = /(^\/*)|(\/*$)/g;

        this.options = options; // use for nodeFactory only

        // sanitize base path as '/pa/th'; (leading, no trailing /)
        this.xrpcNodeAPIBasePath = `/${xrpcNodeAPIBasePath.replace(this.sanitizerRe, '')}`;
        this.proxyHostname = proxyHostname;
        this.xrpcProxyPort = xrpcProxyPort;

        this.nodeFactory = new NodeProxyFactory(this.xrpcNodeAPIBasePath, this.proxyHostname, this.xrpcProxyPort, this.options);
        
        this.proxyNodes = {};

        this.log.debug(`Proxy Manager options: ${JSON.stringify(options)}`);
        this.log.info(`Proxy Manager up! XRPC Node API @http://${this.proxyHostname}:${this.xrpcProxyPort}${this.xrpcNodeAPIBasePath}`);
    }

    sanitizeNodeId(id) {
        let sid = id.replace(this.sanitizerRe, '');
        this.log.debug(`Sanitizing node ID: ${id} -> ${sid}`);
        return sid;
    }
    
    nodeIdFromNodeAPIXrpcPath(path) {
        let id = path.replace(this.xrpcNodeAPIBasePath, '').replace(this.sanitizerRe, '');
        this.log.debug(`API path ${path} ^= node ${id}`);
        return id;
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
                this.log.error(`Cannot instantiate new node handler from xrpc request: ${JSON.stringify(xrpcreq)}`);
                return null;
            }

            this.log.info(`Creating new proxy for node ${id}`);
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
        let xrpcAddress = node && node.xrpcAddress;
        this.log.info(`Routing ${req.path} to ${xrpcAddress}`);
        return xrpcAddress;
    }

    // param 0 gets parsed as string --> explicitly make int
    fixXrpcResponseSerialization(xrpcresp) {
        if(
            !xrpcresp.is_fault &&
            xrpcresp.params[0] &&
            xrpcresp.params[0].length == 3 &&
            parseInt(xrpcresp.params[0][0]) != NaN
        ) {
            this.log.debug(`Fixing XRPC serialization error on message: ${JSON.stringify(xrpcresp)}`);
            xrpcresp.params[0][0] = parseInt(xrpcresp.params[0][0]);
            this.log.debug(`Fixed XRPC message: ${JSON.stringify(xrpcresp)}`);
        }

        return xrpcresp;
    }

    // https://mirrors.talideon.com/articles/multicall.html
    async handleMulticall(targetFn, xrpcreq , xrpcresp) {
        // handle requests only
        if(!xrpcresp) {
            this.log.debug(`Decomposing and handling system.multicall XRPC request: ${JSON.stringify(xrpcreq)}`);
            let multicallXrpcReq = Object.assign({},
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
            this.log.debug(`Reassmebled system.multicall XRPC request to: ${JSON.stringify(multicallXrpcReq)}`);
            return multicallXrpcReq;
        }
        // handle responses
        else {
            this.log.debug(`Decomposing and handling system.multicall XRPC response: ${JSON.stringify(xrpcresp)}; Response to original XRPC request: ${JSON.stringify(xrpcreq)}`);
            let multicallxrpcResp = Object.assign({},
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
            this.log.debug(`Reassmebled system.multicall XRPC response to: ${JSON.stringify(multicallxrpcResp)}`);
            return multicallxrpcResp;
        }
    }

    // MASTER API includes caller_id as proxy node identifier
    // returns modified request; should leave original request intact
    async processMasterAPIMethodCall(xrpcreq) {
        this.log.debug(`XRPC request/call to Master API: ${JSON.stringify(xrpcreq)}`);
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
        this.log.debug(`XRPC response from Master API: ${JSON.stringify(xrpcresp)}; Response to: ${JSON.stringify(xrpcreq)}`);
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
        this.log.debug(`XRPC request/call to Slave/Node API [@${xrpcPath}]: ${JSON.stringify(xrpcreq)}`);
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
        this.log.debug(`XRPC response from Slave/Node API [@${xrpcPath}]: ${JSON.stringify(xrpcresp)}; Response to: ${JSON.stringify(xrpcreq)}`);
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

    dropNode(id) {
        let node = this.proxyNodes[id];
        if(node) {
            this.log.info(`Dropping node ${node.id}`);
            this.log.debug(`Stopping XMLRPC proxy for node ${node.id}`);
            node.xrpcProxy.end();

            this.log.debug(`Stopping TCPROS proxies for node ${node.id}`);
            Object.values(node.TCPROSProxies)
            .forEach((p) => {
                p.end();
            })            

            delete this.proxyNodes[id];
        }
        else {
            this.log.error(`Requested to drop unknown node ${id}`);
        }
    }

    reset() {
        this.log.debug(`Clearing state; disableing housekepping and dropping node registration info`);
        this.housekeeping = false;
        Object.keys(this.proxyNodes).forEach(n => this.dropNode(n));
    }

    isStaleNode(id) {
        let node = this.proxyNodes[id];
        const subscriptions = node.subscriptions.length;
        const publications = node.publications.length;
        const services = node.services.length;
        const is_stale = (subscriptions + publications + services) == 0
        this.log.debug(`Checking if node ${id} is stale: ${subscriptions} subscriptions, ${publications} publications, ${services} services; ${is_stale ? 'STALE' : 'ALIVE'}`);
        return is_stale;
    }

    pingNode(id) {
        this.log.debug(`Pinging node ${id} (using getPid)`);
        return new Promise((resolve, _reject) => {
            let xrpcClient = new uXRPC(this.proxyNodes[id].xrpcAddress);
            xrpcClient.call('getPid', [this.proxyNodes[id].id])
                .then((_res) => {
                    this.log.debug(`Pinging ${id} OK`);
                    resolve(true);
                })
                .catch((_err) => {
                    this.log.debug(`Pinging ${id} UNREACHABLE`);
                    resolve(false);
                });
        });
    }

    async doHousekeeping() {
        this.log.debug('Running housekeeping tasks');

        await Promise.all(
            Object.keys(this.proxyNodes)
            .map(async (n) => {
                let node = this.proxyNodes[n];
                let stale = false;
                if(this.isStaleNode(n)) {
                    this.log.info(`Is stale ${node.id}`);
                    stale = true;
                }
                else if(await this.pingNode(n) == false) {
                    this.log.info(`Is dead ${node.id}`);
                    stale = true;
                }

                if(stale) {
                    this.dropNode(n);
                }
            })
        );
    }

    enableHousekeeping(rate_ms = 5000) {
        this.log.info(`Enabling automatic housekeeping every ${rate_ms}ms`);
        this.housekeeping = true;

        const housekeepingLoop = () => {
            setTimeout(() => {
                if(this.housekeeping) {
                    this.doHousekeeping();
                    housekeepingLoop();
                }
            }, rate_ms);    
        };
        housekeepingLoop();
    }

    stopHousekeeping() {
        this.log.info(`Disabling automatic housekeeping`);
        this.housekeeping = false;
    }
}


module.exports = NodeProxyManager;