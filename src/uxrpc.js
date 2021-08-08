const got = require('got');
const xrpc = require('xrpc');
const XmlRpcMessage = require('xrpc/lib/xmlrpc-message');

const log = require('loglevel');


class uXRPC {
    constructor(target, options) {
        this.options = {};
        Object.assign(this.options, options);
        this.client = got.extend({
            retry: {
                limit: 3,
                methods: ["GET", "POST"]
            }
        });
        this.target = target;

        this.log = log.getLogger(`<${this.constructor.name}> ${target}`);
        this.log.info(`New uXRPC client for target ${this.target}; with options ${JSON.stringify(this.options)}`);
    }

    async call(method, params) {
        this.log.info(`Calling ${method}(${params.join(', ')})`)
        let call = (method instanceof XmlRpcMessage) ? method : new XmlRpcMessage(method, params || []);

        let body = call.xml();
        this.log.debug(`[${method}] Sending: ${body.replace(/\n/g, '')}`);
        let res = await this.client.post(this.target, {
            body: body
        });

        await new Promise((resolve) => {
            xrpc.xmlRpc(res, {}, resolve);
        });

        this.log.debug(`[${method}] Response XML/raw: ${res.rawBody.toString('utf-8').replace(/\n/g, '')}`);
        this.log.debug(`[${method}] Response XRPC: ${JSON.stringify(res.body_XMLRPC)}`);
        return res.body_XMLRPC || {};
    }
}

module.exports = uXRPC;