"use strict";

/**
 * mapper module.
 * @module server/mapper
 *
 * @description Authorisation for access to data sources (sequencing files).
 *              Relies on data access group being known for each data
 *              source and the user having access to a whole set or subset
 *              of data access groups.
 *
 * @example <caption>Example usage of the mapper module.</caption>
 *   const DataAccess = require('../lib/server/mapper.js');
 *   // Create a new object.
 *   var da = new DataMapper(db);
 *   // Register listeners for events this object emits.
 *   da.on('error', (err) => {
 *          console.log(`Error retrieving data: ${err}`);
 *   });
 *   da.on('nodata', (message) => {
 *          console.log(
 *            `No data retrieved: ${message}`);
 *   });
 *   da.on('data', (data) => {
 *          console.log('Data ready');
 *     // Do something with data
 *     // This is how the data object might look
 *     // [{file: "irods:/seq/foo1", accessGroups: "6"},
 *     //  {file: "irods:/seq/foo2", accessGroups: "7"}]
 *   });
 *   // Call mapper
 *   let hostname = 'localhost';
 *   let query = {'accession': 'XYZ45678'};
 *   // Other options:
 *   // let query = {'name': 'my.cram'};
 *   // let query = {'name': 'my.cram', 'directory': 'some'};
 *   dm.getFileInfo(query, hostname);
 *
 * @author Marina Gourtovaia
 * @copyright Genome Research Limited 2016
 */

const LOGGER       = require('winston');

const EventEmitter = require('events');
const http         = require('http');
const path         = require('path');

const config       = require('../config.js');

const FILE_INFO_COLLECTION  = 'fileinfo';
const ERROR_EVENT_NAME      = 'error';
const NO_DATA_EVENT_NAME    = 'nodata';
const DATA_READY_EVENT_NAME = 'data';

/** Class mapping client query to the location and access info of sequencing files. */
class DataMapper extends EventEmitter {
  /**
   * Creates a DataMapper type object.
   * @param db - mongodb connection object
   */
  constructor() {
    super();

    let options = config.provide();
    this.multiref = !!options.get('multiref');
  }

  /**
   * Maps the query to the location and access info of sequencing files.
   * Tries to find files co-located with the given host.
   * Returns an array of objects with information about sequencing files.
   * @param query - an object having either name or accession attribute defined
   * @param host  - host name
   */
  getFileInfo(query, host) {
    if (!query) {
      throw new ReferenceError('Query object is required');
    }
    if (!host) {
      throw new ReferenceError('Host name is required');
    }

    var a = query.accession;
    var dbquery;
    if (a) {
      dbquery = `{"accession":"${a}","target":"1","manual_qc":"1","alignment":"1"}`;
      // dbquery =  { $and: [{'avh.sample_accession_number': a},
      //                     {'avh.target':    "1"},
      //                     {'avh.manual_qc': "1"},
      //                     {'avh.alignment': "1"} ]};
    } else if (query.name) {
      dbquery = { data_object: query.name };
      if (query.directory) {
        dbquery = { $and: [ dbquery, {collection: query.directory} ] };
      }
    } else {
      throw new Error('Sample accession number or file name should be given');
    }

    LOGGER.debug(dbquery);

    let columns = { _id:                     0,
                    access_control_group_id: 1,
                    'filepath_by_host.*':    1,
                    'avh.reference':         1 };
    columns['filepath_by_host.' + host] = 1;

    let files;
    LOGGER.debug('beginning http get');
    http.get({
      protocol: 'http:',
      hostname: 'localhost',
      port: '5984',
      path: '/fileinfo/_design/by_acc/_view/by_acc?key=' + dbquery,
      auth: 'admin:admin'
    }, (response) => {
      let body = '';
      response.on('error', (err) => {
        LOGGER.error('got error in reponse: ' + err.toString());
      });
      response.on('data', (data) => {
        body += data.toString();
      });
      response.on('end', () => {
        LOGGER.debug('got data in response');
        try {
          files = JSON.parse(body.toString()).rows.map(function (datum) {
            return datum.value;
          });
        } catch (e) {
          LOGGER.error('failed to parse json res: ' + e.toString());
          LOGGER.error(resData.toString());
        }

        let data = files.map( (f) => {
          return {file: f};
        });

        this.emit(DATA_READY_EVENT_NAME, data);
      });
    });

    let queryDirectory = query.directory ? ` in ${query.directory}` : '';
    let defaultMessage = a ? `sample accession ${a}`
                           : query.name + queryDirectory;

    let noFilesMessage     = `No files for ${defaultMessage}`;
    let noRefMessage       = `No reference for ${defaultMessage}`;
    let refMismatchMessage = `Not all references match for ${defaultMessage}`;
    //cursor.each( (err, doc) => {
    //  if (err) {
    //    try {
    //      cursor.close();
    //    } catch (e) {
    //      LOGGER.warn('Error while trying to close cursor: ' + e);
    //    }
    //    this.emit(ERROR_EVENT_NAME,
    //      'Failed to map input to files, DB error: ' + err);
    //  } else {
    //    if (doc != null) {
    //      files.push(doc);
    //    } else {
    //      cursor.close();
    //      if (files.length === 0) {
    //        this.emit(NO_DATA_EVENT_NAME, noFilesMessage);
    //      } else {
    //        let data = files.map( (f) => {
    //          let d = {};
    //          d.file        = f.filepath_by_host[host]  || f.filepath_by_host["*"];
    //          d.accessGroup = f.access_control_group_id || '';

    //          if (f.avh.reference) {
    //            d.reference = f.avh.reference;
    //            return d;
    //          }
    //          this.emit(NO_DATA_EVENT_NAME, noRefMessage);
    //        });
    //        data = data.filter( (d) => { return d && d.file; });
    //        if (data.length) {
    //          // Freebayes can only run on one reference .fa file.
    //          // If merging two files, there is no guarantee that both
    //          // use the same reference file. So, when multiref not set,
    //          // throw an error if the reference file names do not match.
    //          // Remember that multiple paths may hold same .fa file, so test
    //          // file name.
    //          if (!this.multiref) {
    //            let refFile = path.basename(data[0].reference);
    //            let allMatch = data.every((element) => {
    //              return path.basename(element.reference) === refFile;
    //            });
    //            if (allMatch) {
    //              this.emit(DATA_READY_EVENT_NAME, data);
    //            } else {
    //              this.emit(NO_DATA_EVENT_NAME, refMismatchMessage);
    //            }
    //          } else {
    //            this.emit(DATA_READY_EVENT_NAME, data);
    //          }
    //        } else {
    //          this.emit(NO_DATA_EVENT_NAME, noFilesMessage);
    //        }
    //      }
    //    }
    //  }
    //});
  }
}

module.exports = DataMapper;
