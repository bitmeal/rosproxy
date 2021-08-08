const ROSProxy = require('./rosproxy');

const commandLineArgs = require('command-line-args');
const Url = require('url-parse');

const log = require('loglevel');
const formatter = require('loglevel-plugin-prefix');
const chalk = require('chalk');

// setup formatted logger
formatter.reg(log);
formatter.apply(log, {
    format(level, name, timestamp) {
        const colors = {
            TRACE: chalk.magenta,
            DEBUG: chalk.cyan,
            INFO: chalk.blue,
            WARN: chalk.yellow,
            ERROR: chalk.red,
        };

        return `${chalk.gray(`[${timestamp}]`)} ${colors[level.toUpperCase()](level)} ${chalk.green(`${name}:`)}`;
    },
});


// get options
function parseRange(range) {
    if(range) {
        return [
                range.split(','),
                range.split('-'),
                range.split(':')
            ].filter((r) => {
                return r.length == 2
            }).map((r) => {
                return r.map((p) => { return parseInt(p); });
            }).filter((r) => {
                return !r.includes(NaN);
            })[0];
    }
    else {
        return undefined;
    }
}

const argsConfig = [
    { name: 'port', type: Number, alias: 'p', defaultOption: true },
    { name: 'ros-master-uri', type: String, alias: 'm' },
    { name: 'hostname', type: String, alias: 'n' },
    { name: 'port-range', type: String, alias: 'r' },
    { name: 'quiet', type: Boolean, alias: 'q' },
    { name: 'debug', type: Boolean, alias: 'd' },
];
const args = commandLineArgs(argsConfig);

const port = args.port || (process.env['ROS_MASTER_URI'] && new Url(process.env['ROS_MASTER_URI']).port);
const portRangeTCP = parseRange(args['port-range']);

const proxyOptions = {
    ROSMasterURI: args['ros-master-uri'] || process.env['ROS_MASTER_URI'],
    ROSHostname: args['hostname'] || process.env['ROS_HOSTNAME'] || process.env['ROS_IP'] || os.hostname(),
    masterAPIBasePath: '/master',
    nodeAPIBasePath: '/node',
    failurePath: '/fault',
    portTCPmin: portRangeTCP && portRangeTCP[0],
    portTCPmax: portRangeTCP && portRangeTCP[1],
    housekeeping: true,
}

function failIfNotSet(val, err) {
    if(!val) {
        log.error(err);
        process.exit(1);
    }
    
}

failIfNotSet(port, 'Port to listen on for XRPC requests not set!');
failIfNotSet(proxyOptions.ROSMasterURI, 'ROS Master URI not set!');
failIfNotSet(proxyOptions.ROSHostname, 'No hostname set!');

// set loglevel(s)
//log.enableAll();
log.setLevel('info');

if(args['quiet']) {
    log.setLevel('silent');
}
if(args['debug']) {
    log.setLevel('debug');
}

// instantiate proxy
log.debug(`ROS Proxy options: ${JSON.stringify({ port: port, options: proxyOptions})}`);
const rosProxy = new ROSProxy(port, proxyOptions);

// run proxy
rosProxy.listen();
