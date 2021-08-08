const NodeProxyManager = require('./src/nodeproxymanager');
const makeXRPCProxyHandler = require('./src/xrpcproxyhandler');
const os = require('os');

const log = require('loglevel');


class ROSProxy {
    constructor(proxyPort, options) {
        this.log = log.getLogger(`<${this.constructor.name}>`);

        this.options = Object.assign({
                ROSMasterURI: process.env['ROS_MASTER_URI'],
                ROSHostname: process.env['ROS_HOSTNAME'] || process.env['ROS_IP'] || os.hostname(),
                    
                masterAPIBasePath: '/master',
                nodeAPIBasePath: '/node',
                failurePath: '/fault',

                // portTCPmin: 30000
                // portTCPmax: 31000

                housekeeping: false,
            },
            options
        );

        // allow use of proxyPort form options dict
        if(!this.options.proxyPort) {
            this.options.proxyPort = proxyPort;
        }

        // check if all options are present
        if(!this.options.ROSMasterURI) {
            throw new Error('ROS master URI not set and not present in ENV!');
        }

        this.log.debug(`ROS proxy options: ${JSON.stringify(this.options)}`);
        // gather proxy port range options
        let managerProxyOpts = {};
        if(this.options.portTCPmin && this.options.portTCPmax) {
            this.log.info(`Limiting usable port range ${this.options.portTCPmin}-${this.options.portTCPmax}`);
            managerProxyOpts.portTCPmin = this.options.portTCPmin;
            managerProxyOpts.portTCPmax = this.options.portTCPmax;
        }

        this.log.debug(`Getting node manager instance`);
        this.nodeManager = new NodeProxyManager(
            this.options.ROSHostname,
            this.options.proxyPort,
            this.options.nodeAPIBasePath,
            managerProxyOpts
        );

        this.log.debug(`Getting XRPC proxy handler instance`);
        this.handler = makeXRPCProxyHandler(
            this.options.ROSMasterURI,
            this.nodeManager,
            {
                failurePath: this.options.failurePath,
                masterAPIBasePath: this.options.masterAPIBasePath
            }
        );
    }

    listen() {
        this.proxy = this.handler.listen(this.options.proxyPort);
        this.log.info(`ROS proxy listening for XRPC calls on port ${this.options.proxyPort}`);
        
        if(this.options.housekeeping) {
            this.log.info(`ROS proxy enabling automatic housekeeping`);
            let args = [this.options.housekeeping].filter(e => typeof e == 'number');
            this.log.debug(`enableHousekeeping args: ${args}`);
            this.nodeManager.enableHousekeeping(...args);
        }
    }

    end() {
        this.log.info(`ROS proxy shutting down`);
        
        if(this.proxy) {
            this.proxy.close();
        }

        this.nodeManager.reset();
    }
}

module.exports = ROSProxy;