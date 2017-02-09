"use strict";

/**
 * configuration module.
 * @module config
 *
 * @description Configuration module for retrieving and providing settings.
 *
 * @example <caption>Example usage.</caption>
 *   const config = require('../lib/config.js');
 *   // Build the config store.
 *   // func should be a function returning an object.
 *   // The values from this object will override any
 *   // found elsewhere, in config files or similar.
 *   function func() {
 *     return { loglevel: 'debug' };
 *   }
 *   config.provide(func);
 *   // Retrieve the 'loglevel' setting
 *   options.get('loglevel'); // true
 *
 * @author Andrew Nowak
 * @copyright Genome Research Limited 2016
 */

const ConfigChain = require('config-chain');
const path        = require('path');
const os          = require('os');
const assert      = require('assert');
const moment      = require('moment');
const GetOpt      = require('node-getopt');

var options;

var fromCommandLine = (optionsList) => {
  var opt = new GetOpt(optionsList).bindHelp().parseSystem();
  return opt.options;
};

/**
 * <p>Builds and/or retrieves the options object. Validates options after they are built
 * If an error happens during validation, the options preceeding this reset attempt
 * are retained.</p>
 * <p><strong>WARNING</strong>: if a function is provided, all configurations
 * originating from a previous function <strong>WILL BE LOST</strong>, including
 * those from a config file (unless the same config file is provided in the new
 * function).</p>
 *
 * @example
 * var options;
 * // Build and retrieve the options object.
 * function foo() {
 *   return {baz: true};
 * }
 * options = config.provide(foo);
 * options.get('baz'); // true
 * // Retrieve the options object without clearing the options object.
 * options = config.provide();
 * options.get('baz'); // true
 * // Clear the options object and rebuild it with the new function
 * function bar() {
 *   return {baz: false};
 * }
 * options = config.provide(bar);
 * options.get('baz'); // false
 *
 * // Make the configuration read-only
 * options = config.provide( () = {
 *   return {baz: true};
 * }, true); // Makes the configuration read-only
 * options = config.provide( () = {
 *   return {baz: false};
 * }); // Will trow Error
 *
 * @param {function} generateConfigs - Function that returns an object. The keys
 *                                     and values of this object will be used to
 *                                     as the keys and values of the resulting
 *                                     options object.
 *                                     <br>
 *                                     If this function is not supplied,
 *                                     <code>provide</code> will attempt to
 *                                     retrieve an already created options
 *                                     object.
 *                                     <br>
 *                                     Configs can be retrieved from a json file if the
 *                                     returned object provides a path specified by the
 *                                     'configfile' key, but the returned object will
 *                                     always take precedence.
 * @param {Boolean} immutable - Determines if the resulting options object will
 *                              be immutable.
 *
 * @throws {AssertionError} Provided parameter was not a function that returned
 *                          an object, or no parameter was provided but options
 *                          had not yet been initialized
 * @throws {RangeError}     If an error in validating options happens
 * @throws {Error}          If an attempt to overwrite a read-only configuration
 *                          is made
 *
 * @return {object} Object which can be queried with <code>.get('key')</code> to
 *                  find the values of a given setting.
 */
var provide = function(provideOpts) {
  let generateConfigs = provideOpts.generateConfigs;
  let immutable = provideOpts.immutable;
  let defaultOptions = provideOpts.defaultOptions;
  let RO_OPTION_KEY = provideOpts.ro_key;
  let adjustOptions = provideOpts.adjustOptions;

  if (generateConfigs) {
    if (options && options.get(RO_OPTION_KEY)) {
      throw new Error('Attempt to overwrite original configuration');
    }
    assert(typeof generateConfigs === 'function', 'parameter must be a function');
    let opts = generateConfigs();
    assert(typeof opts === 'object', 'parameter must return an object');
    let tmpOptions = new ConfigChain(
      opts,
      opts.configfile
        ? path.resolve(opts.configfile)
        : null,
      defaultOptions || null
    );
    if (typeof immutable !== 'undefined') {
      assert(typeof immutable === 'boolean', 'immutable must be boolean');
      tmpOptions.set(RO_OPTION_KEY, immutable);
    }
    if (adjustOptions) {
      adjustOptions(tmpOptions);
    }
    if (tmpOptions.get(RO_OPTION_KEY)) {
      tmpOptions.set = () => {
        throw new Error('Attempt to change read-only configuration');
      };
    }
    options = tmpOptions;
  }
  assert(options, 'Options is undefined');
  return options;
};

var _formatDate = () => {
  return moment().format('YYYYMMDD_HHmmssSS');
};

var _formatRandom = () => {
  let rnd = Math.floor(Math.random() * 10000);
  return `_${rnd}`;
};

var tempFilePath = function(prefix) {
  prefix = prefix ? prefix : '';
  return path.join(os.tmpdir(), prefix + _formatDate() + _formatRandom());
};

var logOpts = function(optionsList, defaultOptions, SECRET_OPTIONS) {
  let loIndex = 1;

  let names = optionsList
    .filter(function(el) {return !el[loIndex].startsWith('help');})
    .sort(function(el1, el2) {return el1[loIndex].localeCompare(el2[loIndex]);})
    .map(function(el) {
      let desc = el[loIndex];
      return desc.split('=', 1).join('');
    });
  // Push all defaultOptions into names
  Array.prototype.push.apply(names, Object.keys(defaultOptions).sort());

  return "\n" + names
    .map(function(name) {
      let value = ( SECRET_OPTIONS.indexOf( name ) === -1 ) ? JSON.stringify(options.get(name))
                                                            : '*****' ;
      return name + '=' + value;
    }).join("\n");
};

module.exports = {
  fromCommandLine: fromCommandLine,
  provide:         provide,
  tempFilePath:    tempFilePath,
  logOpts:         logOpts
};

