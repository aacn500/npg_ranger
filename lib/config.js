'use strict';

const urlParser = require('url');
const fs = require('fs-extra');
const assert = require('assert');
const os = require('os');
const path = require('path');

const configger = require('./configger.js');

const DEFAULT_PROTOCOL = 'http:';
const SECURE_PROTOCOL  = 'https:';
const RO_OPTION_KEY    = 'config_ro';
const SECRET_OPTIONS = [ 'secure_passphrase' ];

const optionsList = [
  ['p','port=PORT'            ,'PORT or socket which server listens on'],
  ['m','mongourl=URI'         ,'URI to contact mongodb'],
  ['t','tempdir=PATH'         ,'PATH of temporary directory'],
  ['H','hostname=HOST'        ,'override hostname with HOST'],
  ['' ,'multiref'             ,'allow merging files with differing references. disables VCF output'],
  ['c','configfile=PATH'      ,'PATH of configfile'],
  ['g','timeout=SECONDS'      ,'SECONDS to wait before killing child processes'],
  ['r','references=PATH'      ,'PATH to dir containing reference repository'],
  ['n','numworkers=NUM'       ,'max NUM of workers to run'],
  ['k','clustermaxdeaths=NUM' ,'maximum number of worker deaths to tolerate in <clustertimeout> secs'],
  ['l','clustertimeout=SECS'  ,'see <clustermaxdeaths>'],
  ['', 'startssl'             ,'start with ssl support'],
  ['', 'secure_key=KEY_PATH'  ,'path to private key in pem format'],
  ['', 'secure_cert=CERT_PATH','path to certificate in pem format'],
  ['s','skipauth'             ,'skip authorisation steps'],
  ['' ,'anyorigin'            ,'accept CORS requests from any origin'],
  ['e','emaildomain=DOMAIN'   ,'email domain to validate the remote user value against'],
  ['' ,'loglevel=[error|warn|info|debug]','set logging level [default: error]'],
  ['V','version'              ,'print version and exit'],
  ['h','help'                 ,'display this help']
];

const defaultOptions = {
  loglevel:         'error',
  [RO_OPTION_KEY]:  false,
  /* cluster */
  numworkers:       1,
  clustermaxdeaths: 10,
  clustertimeout:   10,
  /* end cluster */
  /* ssl configuration */
  secure_key:        '',
  secure_passphrase: '',
  secure_cert:       '',
  /* end ssl configuration */
  originlist:       null,
  emaildomain:      null,
  proxylist:        null,
  protocol:         DEFAULT_PROTOCOL,
  hostname:         os.hostname() || 'localhost',
  mongourl:         'mongodb://localhost:27017/imetacache',
  timeout:          3,
  mongoopt: {
    db: {
      numberofRetries: 5
    },
    server: {
      auto_reconnect: true,
      poolSize:       40,
      socketOptions:  {
        connectTimeoutMS: 5000
      }
    },
    replSet: {},
    mongos:  {}
  }
};

function adjustOptions(opts) {

  let validateURL = (u, name) => {
    u = u.trim();
    if (!u) {
      throw new RangeError(`Empty string in '${name}'`);
    }
    try {
      let urlObj = urlParser.parse(u);
      if (!urlObj.protocol) {
        throw new Error('Protocol is absent');
      }
      if (urlObj.protocol !== opts.get('protocol')) {
        throw new Error('URL protocol should match server protocol');
      }
      if (!(urlObj.host || urlObj.hostname)) {
        throw new Error('Server host is absent');
      }
      if (urlObj.pathname && urlObj.path && urlObj.pathname.length > 1) {
        throw new Error('Path cannot be present');
      }
      if (urlObj.search) {
        throw new Error('Search string cannot be present');
      }
      if (urlObj.hash) {
        throw new Error('Hash tag cannot be present');
      }
      u = urlParser.format(urlObj);
      u = u.replace(/\/*$/, ''); // Drop trailing slash
    } catch (e) {
      throw new RangeError(`Invalid URL ${u} in ${name}: ${e}`);
    }
    return u;
  };

  let setTempDir = () => {
    opts.set('tempdir', (opts.get('tempdir') || tempFilePath('npg_ranger_')));
  };

  let setPort = () => {
    if (!opts.get('port')) {
      if ( opts.get('numworkers') > 1 ) {
        throw new RangeError("'port' is required but not provided");
      } else {
        let fse = require('fs-extra');
        fse.ensureDirSync(opts.get('tempdir'));
        opts.set('port', path.join(opts.get('tempdir'), 'npg_ranger.sock'));
      }
    }
    if (Number.isInteger(Number.parseInt(opts.get('port')))) {
      opts.set('port', Number.parseInt(opts.get('port')));
    }
  };

  let setACAOrigin = () => {
    let or = opts.get('originlist');
    if (opts.get('anyorigin')) {
      if (typeof opts.get('anyorigin') != 'boolean') {
        throw new RangeError("'anyorigin' should be a boolean type value");
      }
      if (or) {
        throw new RangeError("'anyorigin' and 'originlist' options cannot both be set");
      }
      if (!opts.get('skipauth')) {
        throw new RangeError("'anyorigin' option cannot be set if authorization is performed");
      }
    } else if (or) {
      assert(or instanceof Array, "'originlist' should be an array");
      opts.set('originlist',
        or.length === 0
        ? null
        : or.filter((el) => {return el;})
            .map((el) => {
              return validateURL(el, 'originlist');
            })
      );
    }
  };

  let setProxies = () => {
    let proxies = opts.get('proxylist');
    if (proxies) {
      assert(proxies instanceof Object, "'proxilist' should be a hash");
      let urls = Object.keys(proxies);
      if (urls.length === 0) {
        proxies = null;
      } else {
        urls.forEach((el) => {
          if (el) {
            let u = validateURL(el, 'proxylist');
            if (u !== el) {
              proxies[u] = proxies[el];
              delete proxies[el];
            }
          } else {
            throw new RangeError('Empty or zero url in proxilist');
          }
        });
      }
      opts.set('proxylist', proxies);
    }
  };

  let setCluster = () => {
    ['numworkers', 'clustermaxdeaths', 'clustertimeout'].forEach( (optName) => {
      let value = Number.parseInt(opts.get(optName));
      assert(Number.isInteger(value), `${optName} must be an integer`);
      opts.set(optName, value);
    });
  };

  let setSSL = () => {
    let startssl = opts.get('startssl');
    if ( startssl && opts.get('protocol') != SECURE_PROTOCOL ) {
      opts.set('protocol', SECURE_PROTOCOL);
    }

    ['secure_key', 'secure_passphrase', 'secure_cert'].forEach( (optname) => {
      if ( startssl ) {
        if ( optname !== 'secure_passphrase' ) { // passphrase is optional
          let path = opts.get(optname);
          assert(path, `'${optname}' is required when using 'startssl' option`);
          try {
            fs.accessSync(path, fs.R_OK);
          } catch (e) {
            throw Error(
              `File '${path}' is not readable for option '${optname}'`
            );
          }
        }
      } else {
        if ( opts.get(optname) ) {
          throw new RangeError(`'${optname}' option requires startssl to be true`);
        }
      }
    });
  };

  setTempDir();
  setCluster();
  setPort();
  setSSL();
  setACAOrigin();
  setProxies();
}

var fromCommandLine = function() {
  return configger.fromCommandLine(optionsList);
};

var provide = function(generateConfigs, immutable) {
  let provideOpts = {
    generateConfigs: generateConfigs,
    immutable: immutable,
    defaultOptions: defaultOptions,
    ro_key: RO_OPTION_KEY,
    adjustOptions: adjustOptions
  };
  return configger.provide(provideOpts);
};

var tempFilePath = configger.tempFilePath;

var logOpts = function() {
  return configger.logOpts(optionsList, defaultOptions, SECRET_OPTIONS);
};

module.exports = {
  fromCommandLine: fromCommandLine,
  provide:         provide,
  tempFilePath:    tempFilePath,
  logOpts:         logOpts
};
