/*
 * moleculer
 * Copyright (c) 2017 Ice Services (https://github.com/ice-services/moleculer)
 * MIT Licensed
 */

"use strict";

const Promise	= require("bluebird");
const _ 		= require("lodash");

const P 		= require("./packets");
const E 		= require("./errors");

/**
 * Transit class
 *
 * @class Transit
 */
class Transit {

	/**
	 * Create an instance of Transit.
	 *
	 * @param {ServiceBroker} Broker instance
	 * @param {Transporter} Transporter instance
	 * @param {Object?} opts
	 *
	 * @memberOf Transit
	 */
	constructor(broker, transporter, opts) {
		this.broker = broker;
		this.logger = broker.getLogger("transit");
		this.nodeID = broker.nodeID;
		this.tx = transporter;
		this.opts = opts;

		this.pendingRequests = new Map();

		this.stat = {
			packets: {
				sent: 0,
				received: 0
			}
		};

		this.connected = false;
		this.disconnecting = false;

		if (this.tx) {
			this.tx.init(this, this.messageHandler.bind(this), this.afterConnect.bind(this));
		}

		this.__connectResolve = null;
	}

	/**
	 * It will be called after transporter connected or reconnected.
	 *
	 * @param {any} wasReconnect
	 * @returns {Promise}
	 *
	 * @memberof Transit
	 */
	afterConnect(wasReconnect) {
		return Promise.resolve()

			.then(() => {
				if (!wasReconnect)
					return this.makeSubscriptions();
			})

			.then(() => this.discoverNodes())
			.then(() => this.sendNodeInfo())
			.delay(200) // Waiting for incoming INFO packets

			.then(() => {
				this.connected = true;

				this.broker.broadcastLocal("$transporter.connected");

				if (this.__connectResolve) {
					this.__connectResolve();
					this.__connectResolve = null;
				}
			});
	}

	/**
	 * Connect with transporter. If failed, try again after 5 sec.
	 *
	 * @memberOf Transit
	 */
	connect() {
		this.logger.info("Connecting to the transporter...");
		return new Promise(resolve => {
			this.__connectResolve = resolve;

			const doConnect = () => {
				/* istanbul ignore next */
				this.tx.connect().catch(err => {
					if (this.disconnecting) return;

					this.logger.warn("Connection is failed.", err.message);
					this.logger.debug(err);

					setTimeout(() => {
						this.logger.info("Reconnecting...");
						doConnect();
					}, 5 * 1000);
				});
			};

			doConnect();

		});
	}

	/**
	 * Disconnect with transporter
	 *
	 * @memberOf Transit
	 */
	disconnect() {
		this.connected = false;
		this.disconnecting = true;

		this.broker.broadcastLocal("$transporter.disconnected", { graceFul: true });

		if (this.tx.connected) {
			return this.sendDisconnectPacket()
				.then(() => this.tx.disconnect());
		}
		/* istanbul ignore next */
		return Promise.resolve();
	}

	/**
	 * Send DISCONNECT to remote nodes
	 *
	 * @returns {Promise}
	 *
	 * @memberOf Transit
	 */
	sendDisconnectPacket() {
		return this.publish(new P.PacketDisconnect(this));
	}

	/**
	 * Subscribe to topics for transportation
	 *
	 * @memberOf Transit
	 */
	makeSubscriptions() {
		this.subscribing = Promise.all([
			// Subscribe to broadcast events
			this.subscribe(P.PACKET_EVENT, this.nodeID),

			// Subscribe to requests
			this.subscribe(P.PACKET_REQUEST, this.nodeID),

			// Subscribe to node responses of requests
			this.subscribe(P.PACKET_RESPONSE, this.nodeID),

			// Discover handler
			this.subscribe(P.PACKET_DISCOVER),
			this.subscribe(P.PACKET_DISCOVER, this.nodeID),

			// NodeInfo handler
			this.subscribe(P.PACKET_INFO), // Broadcasted INFO. If a new node connected
			this.subscribe(P.PACKET_INFO, this.nodeID), // Response INFO to DISCOVER packet

			// Disconnect handler
			this.subscribe(P.PACKET_DISCONNECT),

			// Heartbeat handler
			this.subscribe(P.PACKET_HEARTBEAT),

			// Ping handler
			this.subscribe(P.PACKET_PING), // Broadcasted
			this.subscribe(P.PACKET_PING, this.nodeID), // Targeted

			// Pong handler
			this.subscribe(P.PACKET_PONG, this.nodeID)

		])
			.then(() => {
				this.subscribing = null;
			});
		return this.subscribing;
	}

	/**
	 * Message handler for incoming packets
	 *
	 * @param {Array} topic
	 * @param {String} msg
	 * @returns {Boolean} If packet is processed return with `true`
	 *
	 * @memberOf Transit
	 */
	messageHandler(cmd, msg) {
		try {

			if (msg == null) {
				throw new E.MoleculerServerError("Missing packet.", 500, "MISSING_PACKET");
			}

			this.stat.packets.received = this.stat.packets.received + 1;

			const packet = P.Packet.deserialize(this, cmd, msg);
			const payload = packet.payload;

			// Check payload
			if (!payload) {
				/* istanbul ignore next */
				throw new E.MoleculerServerError("Missing response payload.", 500, "MISSING_PAYLOAD");
			}

			// Check protocol version
			if (payload.ver != P.PROTOCOL_VERSION) {
				throw new E.ProtocolVersionMismatchError(payload.sender,P.PROTOCOL_VERSION, payload.ver || "1");
			}

			// Skip own packets (if built-in balancer disabled)
			if (payload.sender == this.nodeID && (cmd !== P.PACKET_EVENT && cmd !== P.PACKET_REQUEST && cmd !== P.PACKET_RESPONSE))
				return;


			this.logger.debug(`Incoming ${cmd} packet from '${payload.sender}'`);

			// Request
			if (cmd === P.PACKET_REQUEST) {
				return this._requestHandler(payload);
			}

			// Response
			else if (cmd === P.PACKET_RESPONSE) {
				this._responseHandler(payload);
			}

			// Event
			else if (cmd === P.PACKET_EVENT) {
				this._eventHandler(payload);
			}

			// Discover
			else if (cmd === P.PACKET_DISCOVER) {
				this.sendNodeInfo(payload.sender);
			}

			// Node info
			else if (cmd === P.PACKET_INFO) {
				this.broker.registry.processNodeInfo(payload);
			}

			// Disconnect
			else if (cmd === P.PACKET_DISCONNECT) {
				this.broker.registry.nodeDisconnected(payload);
			}

			// Heartbeat
			else if (cmd === P.PACKET_HEARTBEAT) {
				this.broker.registry.nodeHeartbeat(payload);
			}

			// Ping
			else if (cmd === P.PACKET_PING) {
				this.sendPong(payload);
			}

			// Pong
			else if (cmd === P.PACKET_PONG) {
				this.processPong(payload);
			}

			return true;
		} catch(err) {
			this.logger.error(err, cmd, msg);
		}
		return false;
	}

	/**
	 * Handle incoming event
	 *
	 * @param {any} payload
	 * @memberof Transit
	 */
	_eventHandler(payload) {
		this.logger.debug(`Event '${payload.event}' received from '${payload.sender}' node` + (payload.groups ? ` in '${payload.groups.join(", ")}' group(s)` : "") + ".");

		this.broker.emitLocalServices(payload.event, payload.data, payload.groups, payload.sender);
	}

	/**
	 * Handle incoming request
	 *
	 * @param {Object} payload
	 *
	 * @memberOf Transit
	 */
	_requestHandler(payload) {
		this.logger.debug(`Request '${payload.action}' received from '${payload.sender}' node.`);

		// Recreate caller context
		const ctx = this.broker.ContextFactory.createFromPayload(this.broker, payload);

		return this.broker._handleRemoteRequest(ctx)
			.then(res => this.sendResponse(payload.sender, payload.id,  res, null))
			.catch(err => this.sendResponse(payload.sender, payload.id, null, err));
	}

	/**
	 * Process incoming response of request
	 *
	 * @param {Object} packet
	 *
	 * @memberOf Transit
	 */
	_responseHandler(packet) {
		const id = packet.id;
		const req = this.pendingRequests.get(id);

		// If not exists (timed out), we skip to process the response
		if (req == null) return;

		// Remove pending request
		this.removePendingRequest(id);

		this.logger.debug(`Response '${req.action.name}' received from '${packet.sender}'.`);
		// Update nodeID in context (if it use external balancer)
		req.ctx.nodeID = packet.sender;

		if (!packet.success) {
			// Recreate exception object
			let err = new Error(packet.error.message + ` (NodeID: ${packet.sender})`);
			// TODO create the original error object if it's available
			//   let constructor = errors[packet.error.name]
			//   let error = Object.create(constructor.prototype);
			err.name = packet.error.name;
			err.code = packet.error.code;
			err.type = packet.error.type;
			err.nodeID = packet.error.nodeID || packet.sender;
			err.data = packet.error.data;
			if (packet.error.stack)
				err.stack = packet.error.stack;

			req.reject(err);
		} else {
			req.resolve(packet.data);
		}
	}

	/**
	 * Send a request to a remote service. It returns a Promise
	 * what will be resolved when the response received.
	 *
	 * @param {<Context>} ctx			Context of request
	 * @returns	{Promise}
	 *
	 * @memberOf Transit
	 */
	request(ctx) {
		if (this.opts.maxQueueSize && this.pendingRequests.size > this.opts.maxQueueSize)
			return Promise.reject(new E.QueueIsFull(ctx.action.name, ctx.nodeID, this.pendingRequests.length, this.opts.maxQueueSize));

		// Expanded the code that v8 can optimize it.  (TryCatchStatement disable optimizing)
		return new Promise((resolve, reject) => this._sendRequest(ctx, resolve, reject));
	}

	/**
	 * Send a remote request
	 *
	 * @param {<Context>} ctx 		Context of request
	 * @param {Function} resolve 	Resolve of Promise
	 * @param {Function} reject 	Reject of Promise
	 *
	 * @memberOf Transit
	 */
	_sendRequest(ctx, resolve, reject) {
		const request = {
			action: ctx.action,
			nodeID: ctx.nodeID,
			ctx,
			resolve,
			reject
		};

		const packet = new P.PacketRequest(this, ctx.nodeID, ctx);

		this.logger.debug(`Send '${ctx.action.name}' request to '${ctx.nodeID ? ctx.nodeID : "some"}' node.`);

		// Add to pendings
		this.pendingRequests.set(ctx.id, request);

		//return resolve(ctx.params);

		// Publish request
		this.publish(packet);
	}

	/**
	 * Send an event to a remote node
	 *
	 * @param {String} nodeID
	 * @param {String} eventName
	 * @param {any} data
	 *
	 * @memberOf Transit
	 */
	sendEvent(nodeID, eventName, data) {
		this.logger.debug(`Send '${eventName}' event to '${nodeID}'.`);

		this.publish(new P.PacketEvent(this, nodeID, eventName, data));
	}

	/**
	 * Send a grouped event to remote nodes.
	 * The event is balanced internally.
	 *
	 * @param {String} eventName
	 * @param {any} data
	 * @param {Object} nodeGroups
	 *
	 * @memberOf Transit
	 */
	sendBalancedEvent(eventName, data, nodeGroups) {
		_.forIn(nodeGroups, (groups, nodeID) => {
			this.logger.debug(`Send '${eventName}' event to '${nodeID}' node` + (groups ? ` in '${groups.join(", ")}' group(s)` : "") + ".");

			this.publish(new P.PacketEvent(this, nodeID, eventName, data, groups));
		});
	}

	/**
	 * Send an event to groups.
	 * The transporter should make balancing
	 *
	 * @param {String} eventName
	 * @param {any} data
	 * @param {Object} groups
	 *
	 * @memberOf Transit
	 */
	sendEventToGroups(eventName, data, groups) {
		if (!groups || groups.length == 0)
			groups = this.broker.getEventGroups(eventName);

		if (groups.length == 0)
			return;

		this.logger.debug(`Send '${eventName}' event to '${groups.join(", ")}' group(s).`);
		this.publish(new P.PacketEvent(this, null, eventName, data, groups));
	}

	/**
	 * Remove a pending request
	 *
	 * @param {any} id
	 *
	 * @memberOf Transit
	 */
	removePendingRequest(id) {
		this.pendingRequests.delete(id);
	}

	/**
	 * Remove a pending request
	 *
	 * @param {String} nodeID
	 *
	 * @memberOf Transit
	 */
	removePendingRequestByNodeID(nodeID) {
		this.logger.debug("Remove pending requests");
		this.pendingRequests.forEach((req, id) => {
			if (req.nodeID == nodeID) {
				this.pendingRequests.delete(id);

				// Reject the request
				req.reject(new E.RequestRejected(req.action.name, req.nodeID));
			}
		});
	}

	/**
	 * Send back the response of request
	 *
	 * @param {String} nodeID
	 * @param {String} id
	 * @param {any} data
	 * @param {Error} err
	 *
	 * @memberOf Transit
	 */
	sendResponse(nodeID, id, data, err) {
		// Publish the response
		return this.publish(new P.PacketResponse(this, nodeID, id, data, err));
	}

	/**
	 * Discover other nodes. It will be called after success connect.
	 *
	 * @memberOf Transit
	 */
	discoverNodes() {
		return this.publish(new P.PacketDiscover(this));
	}

	/**
	 * Discover a node. It will be called if we got message from a node
	 * what we don't know.
	 *
	 * @memberOf Transit
	 */
	discoverNode(nodeID) {
		return this.publish(new P.PacketDiscover(this, nodeID));
	}

	/**
	 * Send node info package to other nodes.
	 *
	 * @memberOf Transit
	 */
	sendNodeInfo(nodeID) {
		const info = this.broker.getLocalNodeInfo();

		let p = Promise.resolve();
		if (!nodeID)
			p = this.tx._makeServiceSpecificSubscriptions();

		return p.then(() => this.publish(new P.PacketInfo(this, nodeID, info)));
	}

	/**
	 * Send ping to a node (or all nodes if nodeID is null)
	 *
	 * @param {String?} nodeID
	 * @returns
	 * @memberof Transit
	 */
	sendPing(nodeID) {
		return this.publish(new P.PacketPing(this, nodeID, Date.now()));
	}

	/**
	 * Send back pong response
	 *
	 * @param {Object} payload
	 * @returns
	 * @memberof Transit
	 */
	sendPong(payload) {
		return this.publish(new P.PacketPong(this, payload.sender, payload.time, Date.now()));
	}

	/**
	 * Process incoming PONG packet.
	 * Measure ping time & current time difference.
	 *
	 * @param {Object} payload
	 * @memberof Transit
	 */
	processPong(payload) {
		const now = Date.now();
		const elapsedTime = now - payload.time;
		const timeDiff = Math.round(now - payload.arrived - elapsedTime / 2);

		// this.logger.debug(`PING-PONG from '${payload.sender}' - Time: ${elapsedTime}ms, Time difference: ${timeDiff}ms`);

		this.broker.broadcastLocal("$node.pong", { nodeID: payload.sender, elapsedTime, timeDiff }, payload.sender);
	}

	/**
	 * Send a node heart-beat. It will be called with timer
	 *
	 * @memberOf Transit
	 */
	sendHeartbeat(localNode) {
		return this.publish(new P.PacketHeartbeat(this, localNode.cpu));
	}

	/**
	 * Subscribe via transporter
	 *
	 * @param {String} topic
	 * @param {String=} nodeID
	 *
	 * @memberOf Transit
	 */
	subscribe(topic, nodeID) {
		return this.tx.subscribe(topic, nodeID);
	}

	/**
	 * Publish via transporter
	 *
	 * @param {Packet} Packet
	 *
	 * @memberOf Transit
	 */
	publish(packet) {
		this.logger.debug(`Send ${packet.type} packet to '${packet.target || "all nodes"}'`);

		if (this.subscribing) {
			return this.subscribing
				.then(() => {
					this.stat.packets.sent = this.stat.packets.sent + 1;
					return this.tx.prepublish(packet);
				});
		}
		this.stat.packets.sent = this.stat.packets.sent + 1;
		return this.tx.prepublish(packet);
	}

	/**
	 * Serialize the object
	 *
	 * @param {Object} obj
	 * @returns {Buffer}
	 *
	 * @memberOf Transit
	 */
	serialize(obj, type) {
		return this.broker.serializer.serialize(obj, type);
	}

	/**
	 * Deserialize the incoming Buffer to object
	 *
	 * @param {Buffer} buf
	 * @returns {any}
	 *
	 * @memberOf Transit
	 */
	deserialize(buf, type) {
		if (buf == null) return null;

		return this.broker.serializer.deserialize(buf, type);
	}

}

module.exports = Transit;
