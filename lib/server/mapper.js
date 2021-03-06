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
const path         = require('path');

const config       = require('../config.js');

const FILE_INFO_COLLECTION  = 'fileinfo';
const ERROR_EVENT_NAME      = 'error';
const NO_DATA_EVENT_NAME    = 'nodata';
const DATA_READY_EVENT_NAME = 'data';

/**
 * Returns array of mappings between filters as named in the database and
 * as queried in the url.
 *
 * @private
 */
function _getFilterArray() {
  return [
    {
      name: 'avh.target',
      val: 'target',
      inv: 'target_not',
      default: '1'
    },
    {
      name: 'avh.manual_qc',
      val: 'manual_qc',
      inv: 'manual_qc_not',
      default: '1'
    },
    {
      name: 'avh.alignment',
      val: 'alignment',
      inv: 'alignment_not',
      default: '1'
    },
    {
      name: 'avh.alt_target',
      val: 'alt_target',
      inv: 'alt_target_not',
      default: null
    },
    {
      name: 'avh.alt_process',
      val: 'alt_process',
      inv: 'alt_process_not',
      default: null
    },
    {
      name: 'avh.alignment_filter',
      val: 'alignment_filter',
      inv: 'alignment_filter_not',
      default: null
    }
  ];
}

/**
 * Transforms filters from url query to a mongodb query
 *
 * @private
 */
function _buildSampleDbquery(query, accession) {
  let dbquery =  { $and: [{'avh.sample_accession_number': accession},
                          {'avh.type': { $in: ['bam', 'sam', 'cram'] } }] };

  let filterArr = _getFilterArray();

  for (let filter of filterArr) {
    let val = query[filter.val];
    let inv = query[filter.inv];
    // Only one of filter and its inverse should be defined
    if (val !== undefined && inv !== undefined) {
      return false;
    }

    if (val !== undefined) {
      if (val === 'undef') {
        dbquery.$and.push({[filter.name]: {$exists: false} });
      } else if (val !== '') {
        dbquery.$and.push({[filter.name]: val});
      }
    } else if (inv !== undefined) {
      if (inv === 'undef') {
        dbquery.$and.push({ [filter.name]: {$exists: true} });
      } else if (inv !== '') {
        dbquery.$and.push({ [filter.name]: {$ne: inv} });
      }
    } else if (filter.default !== null) {
      dbquery.$and.push({[filter.name]: filter.default});
    }
  }

  return dbquery;
}

/** Class mapping client query to the location and access info of sequencing files. */
class DataMapper extends EventEmitter {
  /**
   * Creates a DataMapper type object.
   * @param db - mongodb connection object
   */
  constructor(db) {
    super();
    if (!db) {
      throw new ReferenceError('Database handle is required');
    }
    this.db = db;

    let options = config.provide();
    this.multiref = !!options.get('multiref');
  }

  // TODO add method to get distinct reference

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
      dbquery = _buildSampleDbquery(query, a);
      if (dbquery === false) {
        this.emit(NO_DATA_EVENT_NAME, 'Invalid query');
        return;
      }
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

    var cursor = this.db.collection(FILE_INFO_COLLECTION).find(dbquery, columns);
    var files  = [];

    let queryDirectory = query.directory ? ` in ${query.directory}` : '';
    let defaultMessage = a ? `sample accession ${a}`
                           : query.name + queryDirectory;

    let noFilesMessage     = `No files for ${defaultMessage}`;
    let noRefMessage       = `No reference for ${defaultMessage}`;
    let refMismatchMessage = `Not all references match for ${defaultMessage}`;
    cursor.each( (err, doc) => {
      if (err) {
        LOGGER.error('Failed to map input to files, DB error: ' + err +
                     ' Not attempting to recover; closing server');
        try {
          cursor.close();
        } catch (e) {
          LOGGER.warn('Error while trying to close cursor: ' + e);
        }
        this.emit(ERROR_EVENT_NAME,
          'Failed to map input to files, DB error');
      } else {
        if (doc != null) {
          files.push(doc);
        } else {
          cursor.close();
          if (files.length === 0) {
            this.emit(NO_DATA_EVENT_NAME, noFilesMessage);
          } else {
            let data = files.map( (f) => {
              let d = {};
              d.file        = f.filepath_by_host[host]  || f.filepath_by_host["*"];
              d.accessGroup = f.access_control_group_id || '';

              if (f.avh.reference) {
                d.reference = f.avh.reference;
                return d;
              }
              this.emit(NO_DATA_EVENT_NAME, noRefMessage);
            });
            data = data.filter( (d) => { return d && d.file; });
            if (data.length) {
              // Freebayes can only run on one reference .fa file.
              // If merging two files, there is no guarantee that both
              // use the same reference file. So, when multiref not set,
              // throw an error if the reference file names do not match.
              // Remember that multiple paths may hold same .fa file, so test
              // file name.
              if (!this.multiref) {
                let refFile = path.basename(data[0].reference);
                let allMatch = data.every((element) => {
                  return path.basename(element.reference) === refFile;
                });
                if (allMatch) {
                  this.emit(DATA_READY_EVENT_NAME, data);
                } else {
                  this.emit(NO_DATA_EVENT_NAME, refMismatchMessage);
                }
              } else {
                this.emit(DATA_READY_EVENT_NAME, data);
              }
            } else {
              this.emit(NO_DATA_EVENT_NAME, noFilesMessage);
            }
          }
        }
      }
    });
  }

  /**
   * Returns an array of all filters as expected in the url.
   * @public
   */
  static getFilterNames() {
    let names = [];
    _getFilterArray().forEach(function(filterObj) {
      names.push(filterObj.val, filterObj.inv);
    });
    return names;
  }
}

module.exports = DataMapper;
