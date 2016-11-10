"use strict";

const assert       = require('assert');
const EventEmitter = require('events');
const fs           = require('fs-extra');
const http         = require('http');
const path         = require('path');
const MongoClient  = require('mongodb').MongoClient;
const util         = require('util');

const LOGGER           = require('winston');
const config           = require('../lib/config.js');
const RangerController = require('../lib/server/controller');

require('http-shutdown').extend();

/**
 * NodeJS implementation of util
 * @external util
 * @see  {@link https://nodejs.org/dist/latest-v4.x/docs/api/util.html|util}
 */

/**
 * NodeJS path
 * @external path
 * @see  {@link https://nodejs.org/dist/latest-v4.x/docs/api/path.html|path}
 */

/**
  * fs-extra
  * @external fs-extra
  * @see {@link https://www.npmjs.com/package/fs-extra|fs-extra}
  */

/**
 * Official mongodb driver
 * @external mongodb
 * @see {@link https://www.npmjs.com/package/mongodb|mongodb}
 */

/**
 * Utility for gracefully close the server
 * @external http-shutdown
 * @see {@link https://www.npmjs.com/package/http-shutdown|http-shutdown}
 */

/**
 * <p>The business logic of the NPG Ranger server. The module is self sufficient
 * and can start a server itself in a simple format. A more powerful wrapper for
 * this module is provided at {@link module:bin/server|bin/server module}.</p>
 *
 * See {@link module:lib/server~ServerFactory|ServerFactory} for example use.
 * @module lib/server
 *
 * @requires {@link external:assert|assert}
 * @requires {@link external:events|events}
 * @requires {@link external:path|path}
 * @requires {@link external:fs-extra|fs-extra}
 * @requires {@link external:http|http}
 * @requires {@link external:mongodb|mongodb}
 * @requires {@link external:util|util}
 * @requires {@link external:http-shutdown|http-shutdown}
 * @requires {@link external:winston|winston}
 *
 * @copyright Genome Research Limited 2016
 */

/**
 * Name of event emitted when server starts
 * @type {String}
 */
const SERVER_STARTED = 'server_started';
/**
 * Name of event emitted when server stops
 * @type {String}
 */
const SERVER_CLOSED  = 'server_closed';

/**
 *
 * @example
 *
 * let config       = require('../lib/config.js');
 * let RangerServer = require('./lib/server.js')
 *
 * // Assuming your server configuration comes from CLI options
 * config.provide(config.fromCommandLine);
 *
 * let serverFactory = new RangerServer.ServerFactory();
 * serverFactory.on(RangerServer.SERVER_STARTED, ( server ) => {
 *   console.log('server started');
 * });
 * serverFactory.on(RangerServer.SERVER_CLOSED, ( server ) => {
 *   console.log('server closed');
 * });
 * console.log('starting server');
 * serverFactory.startServer();
 *
 */
class ServerFactory extends EventEmitter {

  /**
   * Try to cleanup socket
   */
  cleanup() {
    LOGGER.debug('Sever factory cleaning up');
    let options = config.provide();
    let port    = options.get('port');
    if (typeof port != 'number') {
      try {
        LOGGER.debug('Trying to find socket file to delete');
        // Throws an error if process has no write access to file
        fs.accessSync(port, fs.W_OK);
        try {
          LOGGER.debug(`Trying to remove socket file ${port} `);
          fs.unlinkSync(port);
        } catch (err) {
          LOGGER.info('Socket file cannot be deleted');
        }
      } catch (err) {
        LOGGER.debug(`Socket file is not there: ${err}`);
      }
    }
  }

  /**
   * Validate the socket is not already in use. Exit with error if socket is
   * in use.
   */
  verifySocket() {
    LOGGER.debug('Verifying socket');
    let options = config.provide();
    let port    = options.get('port');
    if (typeof port != 'number') {
      try {
        let dirname  = path.dirname(port);
        let basename = path.basename(port);
        let files = fs.readdirSync(dirname);
        if ( files.indexOf(basename) !== -1 ) {
          LOGGER.error(`Found a prevous socket at ${port}`);
          process.exit(11);
        } else {
          LOGGER.debug('Socket seems to be free');
        }
      } catch (e) {
        LOGGER.error(`Cannot verify if socket exists ${e}`);
        process.exit(1);
      }
    }
  }

  /**
   * Server setup function. Create the server object, establish database,
   * connection, setup server callbacks, start listening for incoming
   * requests.
   */
  startServer() {
    LOGGER.debug('Server factory start server');
    let options = config.provide();
    // Using withShutdown form http-shutdown
    let server = http.createServer().withShutdown();
    let self = this;

    // Exit gracefully on a signal to quit
    [ 'SIGTERM', 'SIGINT', 'SIGHUP' ].forEach( ( sig ) => {
      process.on( sig, () => {
        server.shutdown( () => {
          process.exit(0);
        });
      });
    });

    server.on('close', () => {
      LOGGER.info("\nServer closing");
      self.emit(SERVER_CLOSED, server);
    });

    // Exit gracefully on error, close the database
    // connection and remove the socket file.
    process.on('uncaughtException', (err) => {
      LOGGER.error(`Caught exception: ${err}\n`);
      let code = 1;
      LOGGER.info(`Exiting with code ${code}`);
      process.exit(code);
    });

    // Set up a callback for requests.
    server.on('request', (request, response) => {
      LOGGER.debug("MEMORY USAGE: " + util.inspect(process.memoryUsage()) + "\n");

      // Ensure the processes initiated by request stops if the client disconnects.
      // Closing the response forces an error in the pipeline and allows for a
      // prompt closing of a socket established for this request.
      request.on('close', () => {
        LOGGER.info('CLIENT DISCONNECTED');
        response.end();
      });

      // Create an instance of an application controller and let it
      // handle the request.
      LOGGER.debug('request headers: ' + JSON.stringify(request.headers));
      let controller = new RangerController(request, response);
      controller.handleRequest();
    });

    var createTempDataDir = () => {
      let tmpDir = options.get('tempdir');
      LOGGER.debug(`Using temp data directory ${tmpDir}`);
      fs.ensureDirSync(tmpDir);
    };

    // Synchronously create directory for temporary data, then start listening.
    createTempDataDir(options.get('tempdir'));
    server.listen(options.get('port'), () => {
      LOGGER.info(`Server listening on ${options.get('hostname')}, ${options.get('port')}`);
      self.emit(SERVER_STARTED, server);
    });
  }
}

module.exports = {
  ServerFactory:  ServerFactory,
  SERVER_STARTED: SERVER_STARTED,
  SERVER_CLOSED:  SERVER_CLOSED
};
