const getPort = require('get-port');
const TCPProxy = require('node-tcp-proxy');
const Url = require('url-parse');
const urljoin = require('url-join');

const log = require('loglevel');


// patch tcp proxy log method
{
    let _TCPProxyInstance = TCPProxy.createProxy(0, 'localhost', 0, { quiet: true });
    _TCPProxyInstance.__proto__.getLogger = function(s) {
        // handling one server and port per proxy only; no load balancing
        return log.getLogger(`<${this.constructor.name}> ${this.proxyPort} ~> ${this.serviceHosts[0]}:${this.servicePorts[0]}`);
    };
    _TCPProxyInstance.__proto__.log = function(s) { this.getLogger().info(s); };
    _TCPProxyInstance.end();
}



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

        this.log = log.getLogger(`<${this.constructor.name}> ${this.id}`);

        this.log.info(`New node: ${this.getCallerAPI()} --> ${this.xrpcAddress}`);
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
            this.log.error('Caller XRPC APIs for node', this.id, 'do not match:', caller_api, '<--->', this.xrpcAddress);
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

        this.log.info(`Registering service ${service}`);

        caller_api = this.getCallerAPI();
        service_api = (await this.getRosrpcProxy(service_api));
        return [service, service_api, caller_api];
    }

    async unregisterService(service, service_api) {
        this.removeFirstFromList(this.services, service);

        this.log.info(`Unregistering service ${service}`);

        service_api = (await this.getRosrpcProxy(service_api));
        return [service, service_api];
    }
    
    registerSubscriber(topic, _topic_type, caller_api) {
        // TODO: check caller api
        this.subscriptions.push(topic);

        this.log.info(`Registering subscriber for topic ${topic}`);

        caller_api = this.getCallerAPI();
        return [topic, _topic_type, caller_api];
    }

    unregisterSubscriber(topic, caller_api) {
        this.removeFirstFromList(this.subscriptions, topic);

        this.log.info(`Unregistering subscriber for topic ${topic}`);

        caller_api = this.getCallerAPI();
        return [topic, caller_api];
    }

    registerPublisher(topic, _topic_type, caller_api) {
        // TODO: check caller api
        this.publications.push(topic);

        this.log.info(`Registering as publisher for topic ${topic}`);

        caller_api = this.getCallerAPI();
        return [topic, _topic_type, caller_api];
    }

    unregisterPublisher(topic, caller_api) {
        this.removeFirstFromList(this.publications, topic);

        this.log.info(`Unregistering as publisher for topic ${topic}`);

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
            this.log.debug('Rewriting accepted transports to TCPROS');
            
            let [protocol, topicHostname, topicPort] = protocolParams;
            if(protocol == 'TCPROS') {
                let [hostname, port] = await this.getTCPROSProxyInfo(topicHostname, topicPort);
                return [protocol, hostname, port];
            }
            else {
                // should never happen, as accepted protocols are rewritten to TCPROS only
                this.log.error('Node responded with accepted protocol other than TCPROS!', protocolParams);
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

        this.log.debug(`Processing method call ${method}`);

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

        console.log.debug(`Processing method response for ${method}`);

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

        this.log = log.getLogger(`<${this.constructor.name}>`);

        this.log.debug(`Node Factory options: ${JSON.stringify(options)}`);
        // this.log.info(`Node Factory up! XRPC Node API @ http://${this.proxyHostname}:${this.xrpcProxyPort}${this.xrpcNodeAPIBasePath}`);
        this.log.info(`Node Factory up!`);

        if(options) {
            if(options.portMin && options.portMax) {
                this.getPortOpts = {
                    port: getPort.makeRange(options.portMin, options.portMax)
                }
                this.log.info(`Node Factory providing TCP proxies from port range: ${options.portMin}-${options.portMax}`);
            }
            else if(Array.isArray(options) && options.length == 2) {
                this.getPortOpts = {
                    port: getPort.makeRange(options[0], options[1])
                }
                this.log.info(`Node Factory providing TCP proxies from port range: ${options[0]}-${options[1]}`);
            }
            else {
                this.log.info('Node Factory providing TCP proxies with random port');
            }
        }
    }

    async makeProxy(hostname, port) {
        let proxyPort = await getPort(this.getPortOpts);
        this.log.info(`Creating proxy: ${proxyPort} ~> ${hostname}:${port}`);

        let logging_options = {
            serviceHostSelected: (proxySocket, i) => {
                // needs overriden logger! see top of file
                this.getLogger().info(`New Connection from ${proxySocket.remoteAddress}:${proxySocket.remotePort}`);
            }
        };

        let proxy = TCPProxy.createProxy(proxyPort, hostname, port);
        return proxy;
    }

    async makeNode(id, xrpcAddress) {
        this.log.info(`Instantiating new node ${id}`);

        let xrpcProxy = await this.makeProxy('localhost', this.xrpcProxyPort);
        // id, xrpcAddress, proxyHostname, xrpcProxy, xrpcNodeAPIBasePath, proxyGenerator
        return new NodeProxy(id, xrpcAddress, this.proxyHostname, xrpcProxy, this.xrpcNodeAPIBasePath, this.makeProxy);
    }
}

module.exports = NodeProxyFactory;