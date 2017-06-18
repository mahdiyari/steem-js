import Promise from 'bluebird';
import defaults from 'lodash/defaults';
import isNode from 'detect-node';
import newDebug from 'debug';

import Transport from './base';

let WebSocket;
if (isNode) {
  WebSocket = require('ws'); // eslint-disable-line global-require
} else if (typeof window !== 'undefined') {
  WebSocket = window.WebSocket;
} else {
  throw new Error("Couldn't decide on a `WebSocket` class");
}

const debug = newDebug('steem:ws');
const expectedResponseMs = process.env.EXPECTED_RESPONSE_MS || 2000;

const DEFAULTS = {
  apiIds: {
    database_api: 0,
    login_api: 1,
    follow_api: 2,
    network_broadcast_api: 4,
  },
  id: 0,
};

export default class WsTransport extends Transport {
  constructor(options = {}) {
    defaults(options, DEFAULTS);
    super(options);

    this.apiIds = options.apiIds;

    this.inFlight = 0;
    this.currentP = Promise.fulfilled();
    this.isOpen = false;
    this.releases = [];
    this.requestsTime = {};

    // A Map of api name to a promise to it's API ID refresh call
    this.apiIdsP = {};
  }

  start() {
    if (this.startP) {
      return this.startP;
    }

    const startP = new Promise((resolve, reject) => {
      if (startP !== this.startP) return;
      const url = this.options.get('websocket');
      this.ws = new WebSocket(url);

      const releaseOpen = this.listenTo(this.ws, 'open', () => {
        debug('Opened WS connection with', url);
        this.isOpen = true;
        releaseOpen();
        resolve();
      });

      const releaseClose = this.listenTo(this.ws, 'close', () => {
        debug('Closed WS connection with', url);
        this.isOpen = false;
        delete this.ws;
        this.stop();

        if (startP.isPending()) {
          reject(
            new Error(
              'The WS connection was closed before this operation was made',
            ),
          );
        }
      });

      const releaseMessage = this.listenTo(this.ws, 'message', message => {
        debug('Received message', message.data);
        const id = JSON.parse(message.data).id;
        const msToRespond = Date.now() - this.requestsTime[id];
        delete this.requestsTime[id];
        if (msToRespond > expectedResponseMs) {
          debug(
            `Message received in ${msToRespond}ms, it's over the expected response time of ${expectedResponseMs}ms`,
            message.data,
          );
        }
        this.emit('message', JSON.parse(message.data));
      });

      this.releases = this.releases.concat([
        releaseOpen,
        releaseClose,
        releaseMessage,
      ]);
    });

    this.startP = startP;
    this.getApiIds();

    return startP;
  }

  stop() {
    debug('Stopping...');
    if (this.ws) this.ws.close();
    this.apiIdsP = {};
    delete this.startP;
    delete this.ws;
    this.releases.forEach(release => release());
    this.releases = [];
  }

  /**
   * Refreshes API IDs, populating the `Steem::apiIdsP` map.
   *
   * @param {String} [requestName] If provided, only this API will be refreshed
   * @param {Boolean} [force] If true the API will be forced to refresh, ignoring existing results
   */

  getApiIds(requestName, force) {
    if (!force && requestName && this.apiIdsP[requestName]) {
      return this.apiIdsP[requestName];
    }

    const apiNamesToRefresh = requestName
      ? [requestName]
      : Object.keys(this.apiIds);
    apiNamesToRefresh.forEach(name => {
      this.apiIdsP[name] = this.sendAsync('login_api', {
        method: 'get_api_by_name',
        params: [name],
      }).then(result => {
        if (result != null) {
          this.apiIds[name] = result;
        }
      });
    });

    // If `requestName` was provided, only wait for this API ID
    if (requestName) {
      return this.apiIdsP[requestName];
    }

    // Otherwise wait for all of them
    return Promise.props(this.apiIdsP);
  }

  send(api, data, callback) {
    const id = data.id || this.id++;
    const startP = this.start();

    const apiIdsP = api === 'login_api' && data.method === 'get_api_by_name'
      ? Promise.fulfilled()
      : this.getApiIds(api);

    this.currentP = Promise.join(startP, apiIdsP)
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (!this.ws) {
              reject(
                new Error(
                  'The WS connection was closed while this request was pending',
                ),
              );
              return;
            }

            const payload = JSON.stringify({
              id,
              method: 'call',
              params: [this.apiIds[api], data.method, data.params],
            });

            const release = this.listenTo(this, 'message', message => {
              // We're still seeing old messages
              if (message.id !== id) {
                return;
              }

              this.inFlight -= 1;
              release();

              // Our message's response came back
              const errorCause = message.error;
              if (errorCause) {
                const err = new Error(
                  // eslint-disable-next-line prefer-template
                  (errorCause.message || 'Failed to complete operation') +
                    ' (see err.payload for the full error payload)',
                );
                err.payload = message;
                reject(err);
                return;
              }

              if (api === 'login_api' && data.method === 'login') {
                this.getApiIds('network_broadcast_api', true);
              }

              resolve(message.result);
            });

            debug('Sending message', payload);
            this.requestsTime[id] = Date.now();

            this.inFlight += 1;
            this.ws.send(payload);
          }),
      )
      .nodeify(callback);

    return this.currentP;
  }
}
