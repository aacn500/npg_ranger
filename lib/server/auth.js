"use strict";

/**
 * auth module.
 * @module server/auth
 *
 * @description Authorisation procedure.
 *              Relies on data access group being known for each data
 *              source and the user having access to a whole set or subset
 *              of data access groups.
 *              If the emaildomain configuration option is set, expects
 *              the username to be an e-mail for the given domain.
 *
 * @example <caption>Example usage of the auth module.</caption>
 *   const DataAccess = require('../lib/server/auth.js');
 *
 *   // Example of a database record mapping users to access groups
 *   var records_json = '[
 *     {
 *       "access_control_group_id": "6",
 *       "members": ["alice", "bob", "charles"]
 *     },
 *     {
 *       "access_control_group_id": "7",
 *       "members": ["alice", "bob", "james"]
 *     }
 *   ]';
 *   // Create a new object.
 *   var da = new DataAccess(db);
 *   // Register listeners for events this object emits.
 *   da.on('authorised', (username) => {
 *          console.log(`User ${username} is given access`);
 *        });
 *   da.on('failed', (username, message) => {
 *          console.log(
 *            `Authorisation failed for user '${username}': ${message}`);
 *        });
 *   // Authorise a user for access for data with data access group ids
     // given by the second attribute. Group ids shoudl be strings.
 *   da.authorise('alice', ["6", "34"]);
 *
 * @author Marina Gourtovaia
 * @copyright Genome Research Limited 2016
 */

const LOGGER       = require('winston');
const EventEmitter = require('events');

const config       = require('../config.js');

const ACCESS_CONTROL_COLLECTION = 'access_control_group';
const AUTH_EVENT_NAME           = 'authorised';
const AUTH_FAILED_EVENT_NAME    = 'failed';

/** Class encupsulating authorisation. */
class DataAccess extends EventEmitter {
  /**
   * Creates an DataClass type object.
   * @param db - mpngodb connection object
   */
  constructor(db) {
    super();
    if (!db) {
      throw new ReferenceError('Database handle is required');
    }
    this.db    = db;
  }

  _getName(uname) {
    uname = uname.trim();
    if (uname) {
      let domain = config.provide().get('emaildomain');
      if (domain) {
        // Allow alphanumerics, _, - and . in a username.
        // Ensure special characters are properly escaped.
        let re = new RegExp(
          '([\\w\\.-]+)@' +
          domain.replace(/\./g, '\\.')
          + '$', 'im');
        let result = uname.match(re);
        uname = result ? result[1] : null;
      }
    }
    return uname;
  }

  /**
   * Authorise the user and emit an appropriate event.
   * @param username - username as a string
   * @param accessGroups - an array of access groups to authorise
   *                       the user against
   */
  authorise(username, accessGroups) {
    if (!username) {
      throw new ReferenceError('Username is required');
    }
    let original_username = username;
    username = this._getName(username);
    if (!username) {
      this.emit(AUTH_FAILED_EVENT_NAME, original_username,
        'Invalid user "' + original_username + '"');
      return;
    }

    if (!accessGroups || (accessGroups instanceof Array === false) ||
       (accessGroups.length === 0)) {
      throw new Error('Access groups array is not available');
    }

    if (!accessGroups.every( (id) => { return id; })) {
      this.emit(AUTH_FAILED_EVENT_NAME, original_username,
        'Some access group ids are not defined');
      return;
    }

    let agroupIds = accessGroups.slice(); // Copy the array
    agroupIds.sort();
    agroupIds = agroupIds.filter( function(item, index, thisArray) {
      return (index === 0) ? 1 : ((item === thisArray[index - 1]) ? 0 : 1);
    });
    LOGGER.debug('ACCESS GROUP IDS: ' + agroupIds.join(' '));
    let dbquery = {
      members:                 username,
      access_control_group_id: {$in: agroupIds}
    };

    var countCallback = (err, count) => {
      if (err) {
        this.emit(AUTH_FAILED_EVENT_NAME, original_username,
          'Failed to get authorisation info, DB error: ' + err);
      } else {
        if (count == agroupIds.length) {
          this.emit(AUTH_EVENT_NAME, original_username);
        } else {
          this.emit(AUTH_FAILED_EVENT_NAME, original_username,
            'Not authorised for ' + (count ? 'some' : 'any') + ' of the files');
        }
      }
    };
    this.db.collection(ACCESS_CONTROL_COLLECTION).count(dbquery, countCallback);
  }
}

module.exports = DataAccess;

