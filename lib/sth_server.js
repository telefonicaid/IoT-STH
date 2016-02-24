/* globals module, process, require */

/*
 * Copyright 2015 Telefónica Investigación y Desarrollo, S.A.U
 *
 * This file is part of the Short Time Historic (STH) component
 *
 * STH is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * STH is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with STH.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with: [german.torodelvalle@telefonica.com]
 */

'use strict';

var sthLogger = require('logops');
var sthConfig = require('./sth_configuration');
var sthHelper = require('./sth_helper.js');
var sthDatabase = require('./sth_database');

var hapi = require('hapi');
var joi = require('joi');
var boom = require('boom');
var stream = require('stream');
var fs = require('fs');
var path = require('path');

var server;

var attendedRequests = 0;

/**
 * Returns the logging context associated to a request
 * @param {Object} request The request received
 * @return {Object} The context to be used for logging
 */
function getContext(request) {
  return {
    corr: request.headers[sthConfig.UNICA_CORRELATOR_HEADER] ||
    sthHelper.getUnicaCorrelator(request),
    trans: sthHelper.getTransactionId(),
    op: sthHelper.getOperationType(request)
  };
}

/**
 * Starts the server asynchronously
 * @param {string} host The STH server host
 * @param {string} port The STH server port
 * @param {string} aSTHDatabase The database to be used by the server
 * @param {Function} callback Callback function to notify the result
 *  of the operation
 */
function startServer(host, port, aSTHDatabase, callback) {
  sthDatabase = aSTHDatabase;

  server = new hapi.Server();

  server.on('log', function (event, tags) {
    if (tags.load) {
      sthLogger.warn(
        sthConfig.LOGGING_CONTEXT.SERVER_LOG,
        'event=' + JSON.stringify(event)
      );
    }
  });

  server.on('request-internal', function (request, event, tags) {
    if (tags.error) {
      if (tags.auth || tags.handler || tags.state || tags.payload || tags.validation) {
        sthLogger.warn(
          sthConfig.LOGGING_CONTEXT.SERVER_LOG,
          request.method.toUpperCase() + ' ' + request.url.path +
          ', event=' + JSON.stringify(event)
        );
      } else {
        sthLogger.error(
          sthConfig.LOGGING_CONTEXT.SERVER_LOG,
          request.method.toUpperCase() + ' ' + request.url.path +
          ', event=' + JSON.stringify(event)
        );
      }
    }
  });

  server.connection({
    host: host,
    port: port
  });

  /**
   * Attends raw data requests
   * @param request The request
   * @param reply Hapi's reply function
   */
  function getRawData(request, reply) {
    var response;

    sthDatabase.getCollection(
      {
        service: request.headers['fiware-service'],
        servicePath: request.headers['fiware-servicepath'],
        entityId: request.params.entityId,
        entityType: request.params.entityType,
        attrName: request.params.attrName
      },
      {
        isAggregated: false,
        shouldCreate: false,
        shouldStoreHash: false,
        shouldTruncate: false
      },
      function (err, collection) {
        if (err) {
          // The collection does not exist, reply with en empty response
          sthLogger.warn(
            request.sth.context,
            'Error when getting the collection (the collection may not exist)'
          );

          sthLogger.debug(
            request.sth.context,
            'Responding with no points'
          );
          var emptyResponse = sthHelper.getEmptyResponse();
          var ngsiPayload = sthHelper.getNGSIPayload(
            request.params.entityId,
            request.params.entityType,
            request.params.attrName,
            emptyResponse);
          response = reply(ngsiPayload);
        } else {
          // The collection exists
          sthLogger.debug(
            request.sth.context,
            'The collection exists'
          );

          sthDatabase.getRawData(
            {
              collection: collection,
              entityId: request.params.entityId,
              entityType: request.params.entityType,
              attrName: request.params.attrName,
              lastN: request.query.lastN,
              hLimit: request.query.hLimit,
              hOffset: request.query.hOffset,
              from: request.query.dateFrom,
              to: request.query.dateTo,
              filetype: request.query.filetype
            },
            function (err, result) {
              if (err) {
                // Error when getting the aggregated data
                sthLogger.error(
                  request.sth.context,
                  'Error when getting data from collection'
                );
                sthLogger.debug(
                  request.sth.context,
                  'Responding with 500 - Internal Error'
                );
                response = reply(err);
              } else if (!result || !(result.length || result instanceof stream)) {
                // No aggregated data available for the request
                sthLogger.debug(
                  request.sth.context,
                  'No aggregated data available for the request: ' + request.url.path
                );

                sthLogger.debug(
                  request.sth.context,
                  'Responding with no points'
                );
                response = reply(
                  sthHelper.getNGSIPayload(
                    request.params.entityId,
                    request.params.entityType,
                    request.params.attrName,
                    sthHelper.getEmptyResponse()
                  )
                );
              } else {
                if (result instanceof stream) {
                  sthLogger.debug(
                    request.sth.context,
                    'Responding with a stream of docs'
                  );
                  response = reply(new stream.Readable().wrap(result));
                } else if (typeof(result) === 'string') {
                  sthLogger.debug(
                    request.sth.context,
                    'Responding with file \'' + result + '\''
                  );
                  response = reply.file(result);
                  var fileName = result.substring(result.lastIndexOf(path.sep) + 1);
                  response.header('Content-Disposition', 'attachment; filename=' + fileName);
                  response.once('finish', function () {
                    sthLogger.debug(
                      request.sth.context,
                      'Removing file \'' + result + '\''
                    );
                    fs.unlink(result, function (err) {
                      if (!err) {
                        sthLogger.debug(
                          request.sth.context,
                          'File \'' + result + '\' successfully removed'
                        );
                      } else {
                        sthLogger.warn(
                          request.sth.context,
                          'Error when removing file \'' + result + '\': ' + err
                        );
                      }
                    });
                  });
                } else {
                  sthLogger.debug(
                    request.sth.context,
                    'Responding with %s docs',
                    result.length
                  );
                  response = reply(
                    sthHelper.getNGSIPayload(
                      request.params.entityId,
                      request.params.entityType,
                      request.params.attrName,
                      result));
                }
              }
              if (request.headers[sthConfig.UNICA_CORRELATOR_HEADER]) {
                response.header('Unica-Correlator', request.headers[sthConfig.UNICA_CORRELATOR_HEADER]);
              }
            }
          );
        }
      }
    );
  }

  /**
   * Attends aggregated data requests
   * @param request The request
   * @param reply Hapi's reply function
   */
  function getAggregatedData(request, reply) {
    var response;

    sthDatabase.getCollection(
      {
        service: request.headers['fiware-service'],
        servicePath: request.headers['fiware-servicepath'],
        entityId: request.params.entityId,
        entityType: request.params.entityType,
        attrName: request.params.attrName
      },
      {
        isAggregated: true,
        shouldCreate: false,
        shouldStoreHash: false,
        shouldTruncate: false
      },
      function (err, collection) {
        if (err) {
          // The collection does not exist, reply with en empty response
          sthLogger.warn(
            request.sth.context,
            'Error when getting the collection (the collection may not exist)'
          );

          sthLogger.debug(
            request.sth.context,
            'Responding with no points'
          );
          var emptyResponse = sthHelper.getEmptyResponse();
          var ngsiPayload = sthHelper.getNGSIPayload(
            request.params.entityId,
            request.params.entityType,
            request.params.attrName,
            emptyResponse);
          response = reply(ngsiPayload);
        } else {
          // The collection exists
          sthLogger.debug(
            request.sth.context,
            'The collection exists'
          );

          sthDatabase.getAggregatedData(
            {
              collection: collection,
              entityId: request.params.entityId,
              entityType: request.params.entityType,
              attrName: request.params.attrName,
              aggregatedFunction: request.query.aggrMethod,
              resolution: request.query.aggrPeriod,
              from: request.query.dateFrom,
              to: request.query.dateTo,
              shouldFilter: sthConfig.FILTER_OUT_EMPTY
            },
            function (err, result) {
              if (err) {
                // Error when getting the aggregated data
                sthLogger.error(
                  request.sth.context,
                  'Error when getting data from collection'
                );
                sthLogger.debug(
                  request.sth.context,
                  'Responding with 500 - Internal Error'
                );
                response = reply(err);
              } else if (!result || !result.length) {
                // No aggregated data available for the request
                sthLogger.debug(
                  request.sth.context,
                  'No aggregated data available for the request: ' + request.url.path
                );

                sthLogger.debug(
                  request.sth.context,
                  'Responding with no points'
                );
                response = reply(
                  sthHelper.getNGSIPayload(
                    request.params.entityId,
                    request.params.entityType,
                    request.params.attrName,
                    sthHelper.getEmptyResponse()
                  )
                );
              } else {
                sthLogger.debug(
                  request.sth.context,
                  'Responding with %s docs',
                  result.length
                );
                response = reply(
                  sthHelper.getNGSIPayload(
                    request.params.entityId,
                    request.params.entityType,
                    request.params.attrName,
                    result));
              }
              if (request.headers[sthConfig.UNICA_CORRELATOR_HEADER]) {
                response.header('Unica-Correlator', request.headers[sthConfig.UNICA_CORRELATOR_HEADER]);
              }
            }
          );
        }
      }
    );
  }

  /**
   * Stores raw data into the database
   * @param data The received data (it is an object including the following properties:
   *  - {object} contextElement The context element
   *  - {object} attribute The attribute
   *  - {date} recvTime The timestamp of the notification when it reached the server
   *  - {object} counterObj A helper counter object. This is needed since Javascript implements calls-by-sharing
   *      (see http://en.wikipedia.org/wiki/Evaluation_strategy#Call_by_sharing) and the counter is shared between
   *      rawAggregatedData() and storeAggregatedData() functions to let them synchronize
   *  - {number} totalTasks The total number of writings to make
   *  @param {function} reply The Hapi server's reply function
   *  @param {function} callback The callback to notify that the operation has completed with error or successfully
   */
  function storeRawData(data, reply, callback) {
    var request = data.request,
      contextElement = data.contextElement,
      attribute = data.attribute,
      recvTime = data.recvTime,
      notificationInfo = data.notificationInfo,
      counterObj = data.counterObj,
      totalTasks = data.totalTasks;

    var service = request.headers['fiware-service'];
    var servicePath = request.headers['fiware-servicepath'];

    // Get the collection
    sthDatabase.getCollection(
      {
        service: service,
        servicePath: servicePath,
        entityId: contextElement.id,
        entityType: contextElement.type,
        attrName: attribute.name
      },
      {
        isAggregated: false,
        shouldCreate: true,
        shouldStoreHash: true,
        shouldTruncate: true
      },
      function (err, collection) {
        if (err) {
          // There was an error when getting the collection
          sthLogger.error(
            request.sth.context,
            'Error when getting the collection: ' + err
          );
          if (++counterObj.counter === totalTasks) {
            reply(err);
          }
          process.nextTick(callback.bind(null, err));
        } else {
          // The collection exists
          sthLogger.debug(
            request.sth.context,
            'The collection exists'
          );

          if (sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.ONLY_RAW ||
            sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.BOTH) {
            sthDatabase.storeRawData(
              {
                collection: collection,
                recvTime: recvTime,
                entityId: contextElement.id,
                entityType: contextElement.type,
                attribute: attribute,
                notificationInfo: notificationInfo
              },
              function (err) {
                if (err) {
                  if (err.code === 11000 && err.message.indexOf('duplicate key error') >= 0) {
                    sthLogger.debug(
                      request.sth.context,
                      'Error when storing the raw data associated to a notification event: ' + err
                    );
                  } else {
                    sthLogger.error(
                      request.sth.context,
                      'Error when storing the raw data associated to a notification event: ' + err
                    );
                  }
                } else {
                  sthLogger.debug(
                    request.sth.context,
                    'Raw data associated to a notification event successfully stored'
                  );
                }
                if (++counterObj.counter === totalTasks) {
                  reply(err);
                }
                process.nextTick(callback.bind(null, err));
              }
            );
          } else {
            process.nextTick(callback);
          }
        }
      }
    );
  }

  /**
   * Stores aggregated data into the database
   * @param data The received data (it is an object including the following properties:
   *  - {object} contextElement The context element
   *  - {object} attribute The attribute
   *  - {date} recvTime The timestamp of the notification when it reached the server
   *  - {object} counterObj A helper counter object. This is needed since Javascript implements calls-by-sharing
   *      (see http://en.wikipedia.org/wiki/Evaluation_strategy#Call_by_sharing) and the counter is shared between
   *      rawAggregatedData() and storeAggregatedData() functions to let them synchronize
   *  - {number} totalTasks The total number of writings to make
   *  @param {function} reply The Hapi server's reply function
   */
  function storeAggregatedData(data, reply) {
    var request = data.request,
        contextElement = data.contextElement,
        attribute = data.attribute,
        recvTime = data.recvTime,
        notificationInfo = data.notificationInfo,
        counterObj = data.counterObj,
        totalTasks = data.totalTasks;

    var service = request.headers['fiware-service'];
    var servicePath = request.headers['fiware-servicepath'];

    // Get the collection
    sthDatabase.getCollection(
      {
        service: service,
        servicePath: servicePath,
        entityId: contextElement.id,
        entityType: contextElement.type,
        attrName: attribute.name
      },
      {
        isAggregated: true,
        shouldCreate: true,
        shouldStoreHash: true,
        shouldTruncate: true
      },
      function (err, collection) {
        if (err) {
          // There was an error when getting the collection
          sthLogger.error(
            request.sth.context,
            'Error when getting the collection'
          );
          if (++counterObj.counter === totalTasks) {
            return reply(err);
          }
        } else {
          // The collection exists
          sthLogger.debug(
            request.sth.context,
            'The collection exists'
          );

          if (sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.ONLY_AGGREGATED ||
            sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.BOTH) {
            sthDatabase.storeAggregatedData(
              {
                collection: collection,
                recvTime: recvTime,
                entityId: contextElement.id,
                entityType: contextElement.type,
                attribute: attribute,
                notificationInfo: notificationInfo
              },
              function (err) {
                if (err) {
                  sthLogger.error(
                    request.sth.context,
                    'Error when storing the aggregated data associated to a notification event'
                  );
                } else {
                  sthLogger.debug(
                    request.sth.context,
                    'Aggregated data associated to a notification event successfully stored'
                  );
                }
                if (++counterObj.counter === totalTasks) {
                  reply(err);
                }
              }
            );
          }
        }
      }
    );
  }

  /**
   * Returns information about the notification once analysed
   * @param data The received data (it is an object including the following properties:
   *  - {object} contextElement: The context element
   *  - {object} attribute: The attribute
   *  - {date} recvTime: The timestamp of the notification when it reached the server
   * @param callback The callback to notify once the function finishes it processing
   * @return {object} Information about the notification
   */
  function getNotificationInfo(data, callback) {
    var request = data.request,
      contextElement = data.contextElement,
      attribute = data.attribute,
      recvTime = data.recvTime;

    var service = request.headers['fiware-service'];
    var servicePath = request.headers['fiware-servicepath'];

    // Get the collection
    sthDatabase.getCollection(
      {
        service: service,
        servicePath: servicePath,
        entityId: contextElement.id,
        entityType: contextElement.type,
        attrName: attribute.name
      },
      {
        isAggregated: false,
        shouldCreate: false,
        shouldStoreHash: false,
        shouldTruncate: false
      },
      function (err, collection) {
        if (err) {
          var result;
          // There was an error when getting the collection, it probably does not exist
          sthLogger.debug(
            request.sth.context,
            'Error when getting the collection: ' + JSON.stringify(err)
          );
          if (err.name === 'MongoError' && err.message.indexOf('does not exist. Currently in strict mode')) {
            result = {inserts: true};
            process.nextTick(callback.bind(null, null, result));
          } else {
            process.nextTick(callback.bind(null, err));
          }
        } else {
          // The collection exists
          sthLogger.debug(
            request.sth.context,
            'The collection exists'
          );

          sthDatabase.getNotificationInfo(
            {
              collection: collection,
              recvTime: recvTime,
              entityId: contextElement.id,
              entityType: contextElement.type,
              attribute: attribute
            },
            function (err, result) {
              if (err) {
                sthLogger.error(
                  request.sth.context,
                  'Error when getting the notification info'
                );
              }
              process.nextTick(callback.bind(null, err, result));
            }
          );
        }
      }
    );
  }

  /**
   * Returns the total number of attributes to be processed
   * @param contextResponses The contextResponses element received in the request
   * @return {number} The total number of attributes to be processed
   */
  function getTotalAttributes(contextResponses) {
    var totalAttributes = 0;
    var contextElement, attributes;
    for (var l1 = 0; l1 < contextResponses.length; l1++) {
      if (contextResponses[l1].contextElement &&
        contextResponses[l1].contextElement.attributes &&
        Array.isArray(contextResponses[l1].contextElement.attributes)) {
        contextElement = contextResponses[l1].contextElement;
        attributes = contextElement.attributes;
        for (var l2 = 0; l2 < attributes.length; l2++) {
          if (!attributes[l2].value ||
            (typeof(attributes[l2].value) !== 'string' && typeof(attributes[l2].value) !== 'number') ||
            (sthConfig.IGNORE_BLANK_SPACES && typeof(attributes[l2].value) === 'string' &&
            attributes[l2].value.trim() === '')) {
            continue;
          }
          totalAttributes++;
        }
      }
    }
    return totalAttributes;
  }

  /**
   * Processes each attribute received in a new notification
   * @param {object} data Data object including the following properties:
   *  - {object} request The request received
   *  - {object} contextElement The context element included in the received request
   *  - {attribute} attribute The attribute to process
   *  - {Date} The date and time when the notification was received
   *  - {object} counterObj A helper counter object. This is needed since Javascript implements calls-by-sharing
   *      (see http://en.wikipedia.org/wiki/Evaluation_strategy#Call_by_sharing) and the counter is shared between
   *      rawAggregatedData() and storeAggregatedData() functions to let them synchronize
   *  - {number} totalTasks The total number of writings to make
   * @param {function} hapi's reply function
   */
  function processAttribute(data, reply) {
    var attribute = data.attribute;
    if (!attribute.value ||
      (typeof(attribute.value) !== 'string' && typeof(attribute.value) !== 'number') ||
      (sthConfig.IGNORE_BLANK_SPACES && typeof(attribute.value) === 'string' &&
      attribute.value.trim() === '')) {
      sthLogger.warn(
        sthConfig.LOGGING_CONTEXT.SERVER_LOG,
        'Attribute value not aggregatable'
      );
      return;
    }

    getNotificationInfo(
      data,
      function onNotificationInfo(err, result) {
        data.notificationInfo = result;

        if (!err && !result.exists) {
          // Store the raw data into the database
          storeRawData(data, reply, function (err) {
            if (err) {
              if (err.code === 11000 && err.message.indexOf('duplicate key error') >= 0) {
                sthLogger.debug(
                  data.request.sth.context,
                  'Ignoring the notification since already registered'
                );
                err = null;
              }
              if (++data.counterObj.counter === data.totalTasks) {
                reply(err);
              }
            } else {
              // Store the aggregated data into the database
              storeAggregatedData(data, reply);
            }
          });
        } else {
          if (err) {
            sthLogger.debug(
              data.request.sth.context,
              'Error when getting the notification information: ' + err
            );
          } else if (result.exists) {
            sthLogger.debug(
              data.request.sth.context,
              'Ignoring the notification since already registered'
            );
          }
          data.counterObj.counter += sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.BOTH ?
            2 : 1;
          if (data.counterObj.counter === data.totalTasks) {
            reply(err);
          }
        }
      }
    );
  }

  /**
   * Processes and stores the raw and aggregated data associated to the attribute values received in a
   *  notification request
   * @param recvTime The time the request was received
   * @param request The received request
   * @param reply The reply function provided by hapi
   * @return {*} This function does not return anything of value
   */
  function processNotification(recvTime, request, reply) {
    var contextElement, attributes;

    // An object is needed since Javascript implements calls-by-sharing
    //  (see http://en.wikipedia.org/wiki/Evaluation_strategy#Call_by_sharing) and the counter is shared between
    //  rawAggregatedData() and storeAggregatedData() functions to let them synchronize
    var counterObj = {
      counter: 0
    };

    var contextResponses = request.payload.contextResponses;

    var totalAttributes = getTotalAttributes(contextResponses);

    var totalTasks = sthConfig.SHOULD_STORE === sthConfig.DATA_TO_STORE.BOTH ?
      (2 * totalAttributes) : (1 * totalAttributes);

    if (totalAttributes === 0) {
      var message = 'At least one attribute with an aggregatable value should be included in the notification';
      sthLogger.warn(
        sthConfig.LOGGING_CONTEXT.SERVER_LOG,
        request.method.toUpperCase() + ' ' + request.url.path +
        ', error=' + message
      );
      var error = boom.badRequest(message);
      error.output.payload.validation = {source: 'payload', keys: ['attributes']};
      return reply(error);
    }

    for (var i = 0; i < contextResponses.length; i++) {
      if (contextResponses[i].contextElement &&
        contextResponses[i].contextElement.attributes &&
        Array.isArray(contextResponses[i].contextElement.attributes)) {
        contextElement = contextResponses[i].contextElement;
        attributes = contextElement.attributes;
        for (var j = 0; j < attributes.length; j++) {
          processAttribute(
            {
              request: request,
              contextElement: contextElement,
              attribute: attributes[j],
              recvTime: recvTime,
              counterObj: counterObj,
              totalTasks: totalTasks
            },
            reply
          );
        }
      }
    }
  }

  /**
   * Returns a textual description of the received request and the data included in it
   * @param request The received request
   * @return {string} The description of the received request including the data included in it
   */
  function getRequestDescription(request) {
    return 'service (' + request.headers['fiware-service'] +
      '), service path (' + request.headers['fiware-servicepath'] + ')' +
      (request.params.entityId ? ', entity id (' + request.params.entityId + ')' : '') +
      (request.params.entityType ? ', entity type (' + request.params.entityType  + ')' : '') +
      (request.params.attrName ? ', attribute name (' + request.params.attrName  + ')' : '');
  }

  /**
   * Handler in case a removal request is received
   * @param request The received request
   * @param reply hapi's server reply() function
   */
  function removeDataHandler(request, reply) {
    request.sth = request.sth || {};
    request.sth.context = getContext(request);

    sthLogger.debug(
      request.sth.context,
      request.method.toUpperCase() + ' ' + request.url.path +
        ' with headers: ' + JSON.stringify(request.headers)
    );

    sthDatabase.removeData(
      {
        service: request.headers['fiware-service'],
        servicePath: request.headers['fiware-servicepath'],
        entityId: request.params && request.params.entityId,
        entityType: request.params && request.params.entityType,
        attrName: request.params && request.params.attrName
      },
      function(err) {
        if (err) {
          if (err.name === 'MongoError' && err.message.indexOf('does not exist. Currently in strict mode')) {
            // There is no associated data for the provided service, service path and entity
            sthLogger.debug(
              request.sth.context,
              'No data associated to the provided ' + getRequestDescription(request) + ' available'
            );
            // Reply with no error
            return reply().code(204);
          } else {
            sthLogger.warn(
              request.sth.context,
              'Error when removing the data associated to an entity: ' + err
            );
            // Reply with error
            return reply(err);
          }
        } else {
          sthLogger.debug(
            request.sth.context,
            'Data associated to the provided ' + getRequestDescription(request) + ' successfully removed'
          );
          return reply().code(204);
        }
      }
    );
  }

  /**
   * Header validation handler
   * @param value The headers
   * @param options Possible options
   * @param next The header validation next() function
   * @return {*} This function does not return anything of interest
   */
  function validateHeaders(value, options, next) {
    var error, message;

    attendedRequests++;

    if (!value['fiware-service']) {
      message = 'error=child "fiware-service" fails because [fiware-service is required]';
      sthLogger.warn(
        sthConfig.LOGGING_CONTEXT.SERVER_LOG,
        message
      );
      error = boom.badRequest(message);
      return next(error);
    } else if (!value['fiware-servicepath']) {
      message = 'child "fiware-servicepath" fails because [fiware-servicepath is required]';
      sthLogger.warn(
        sthConfig.LOGGING_CONTEXT.SERVER_LOG,
        message
      );
      error = boom.badRequest(message);
      return next(error);
    }
    return next();
  }

  server.route([
    {
      method: 'GET',
      path: '/STH/v1/contextEntities/type/{entityType}/id/{entityId}/attributes/{attrName}',
      handler: function (request, reply) {
        request.sth = request.sth || {};
        request.sth.context = getContext(request);

        sthLogger.debug(
          request.sth.context,
          request.method.toUpperCase() + ' ' + request.url.path + ' with headers: ' +
            JSON.stringify(request.headers)
        );

        if ((request.query.lastN || request.query.lastN === 0) ||
          ((request.query.hLimit || request.query.hLimit === 0) &&
          (request.query.hOffset || request.query.hOffset === 0)) ||
          (request.query.filetype && request.query.filetype.toLowerCase() === 'csv')) {
          // Raw data is requested
          getRawData(request, reply);
        } else if (request.query.aggrMethod && request.query.aggrPeriod) {
          // Aggregated data is requested
          getAggregatedData(request, reply);
        } else {
          var message = 'A combination of the following query params is required: lastN, hLimit and hOffset, ' +
            'filetype, or aggrMethod and aggrPeriod';
          sthLogger.warn(
            sthConfig.LOGGING_CONTEXT.SERVER_LOG,
            request.method.toUpperCase() + ' ' + request.url.path +
            ', error=' + message
          );
          var error = boom.badRequest(message);
          error.output.payload.validation = {
            source: 'query',
            keys: ['lastN', 'hLimit', 'hOffset', 'filetype', 'aggrMethod', 'aggrPeriod']
          };
          return reply(error);
        }
      },
      config: {
        validate: {
          headers: validateHeaders,
          query: {
            lastN: joi.number().integer().greater(-1).optional(),
            hLimit: joi.number().integer().greater(-1).optional(),
            hOffset: joi.number().integer().greater(-1).optional(),
            aggrMethod: joi.string().valid('max', 'min', 'sum', 'sum2', 'occur').optional(),
            aggrPeriod: joi.string().required().valid('month', 'day', 'hour', 'minute', 'second').optional(),
            dateFrom: joi.date().optional(),
            dateTo: joi.date().optional(),
            filetype: joi.string().optional()
          }
        }
      }
    },
    {
      method: 'GET',
      path: '/version',
      handler: function (request, reply) {
        var message = sthHelper.getVersion();
        return reply(message);
      }
    },
    {
      method: 'POST',
      path: '/notify',
      handler: function (request, reply) {
        var recvTime = new Date();

        request.sth = request.sth || {};
        request.sth.context = getContext(request);

        sthLogger.debug(
          request.sth.context,
          request.method.toUpperCase() + ' ' + request.url.path + ' with headers: ' +
            JSON.stringify(request.headers) + ' and payload: ' + JSON.stringify(request.payload)
        );

        if (request.payload && request.payload.contextResponses &&
          Array.isArray(request.payload.contextResponses)) {
          processNotification(recvTime, request, reply);
        }
      },
      config: {
        validate: {
          headers: validateHeaders
        }
      }
    },
    {
      method: 'DELETE',
      path: '/STH/v1/contextEntities',
      handler: removeDataHandler,
      config: {
        validate: {
          headers: validateHeaders
        }
      }
    },
    {
      method: 'DELETE',
      path: '/STH/v1/contextEntities/type/{entityType}/id/{entityId}',
      handler: removeDataHandler,
      config: {
        validate: {
          headers: validateHeaders
        }
      }
    },
    {
      method: 'DELETE',
      path: '/STH/v1/contextEntities/type/{entityType}/id/{entityId}/attributes/{attrName}',
      handler: removeDataHandler,
      config: {
        validate: {
          headers: validateHeaders
        }
      }
    }
  ]);

  // Start the server
  server.start(function (err) {
    return callback(err, server);
  });
}

/**
 * Stops the server asynchronously
 * @param {Function} callback Callback function to notify the result
 *  of the operation
 */
function stopServer(callback) {
  sthLogger.info(
    sthConfig.LOGGING_CONTEXT.SERVER_STOP,
    'Stopping the STH server...'
  );
  if (server && server.info && server.info.started) {
    server.stop(function (err) {
      // Server successfully stopped
      sthLogger.info(
        sthConfig.LOGGING_CONTEXT.SERVER_STOP,
        'hapi server successfully stopped'
      );
      return callback(err);
    });
  } else {
    sthLogger.info(
      sthConfig.LOGGING_CONTEXT.SERVER_STOP,
      'No hapi server running'
    );
    return process.nextTick(callback);
  }
}

/**
 * Returns the server KPIs
 * @return {{attendedRequests: number}}
 */
function getKPIs() {
  return {
    attendedRequests: attendedRequests
  };
}

/**
 * Resets the server KPIs
 */
function resetKPIs() {
  attendedRequests = 0;
}

module.exports = {
  get server() {
    return server;
  },
  startServer: startServer,
  stopServer: stopServer,
  getKPIs: getKPIs,
  resetKPIs: resetKPIs
};
