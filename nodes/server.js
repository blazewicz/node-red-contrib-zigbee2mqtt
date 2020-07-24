const { once } = require('events');
const Viz = require('viz.js');
const { Module, render } = require('viz.js/full.render.js');
const { tryJson, payload2homekit } = require('../lib/Zigbee2mqttHelper.js');

module.exports = function (RED) {
    class ServerNode{
        constructor(n) {
            RED.nodes.createNode(this, n);

            const node = this;
            node.config = n;
            node.broker = node.config.broker;
            node.brokerConn = RED.nodes.getNode(node.broker);
            node.config.qos = node.config.qos || 2
            node.topic = node.config.base_topic+'/#';
            node.groups = undefined;
            node.devices = undefined;
            node.devices_values = [];
            node.bridge_config = null;
            node.bridge_state = null;
            node.map = null;

            node.setMaxListeners(0);

            if (node.brokerConn) {
                node.brokerConn.register(node);
                node.brokerConn.subscribe(node.topic, node.config.qos,
                    (topic, payload, packet) => node.onMQTTMessage(topic, payload, packet), node.id);
                node.brokerConn.client.on('connect', () => {
                    node.log('Broker connected');
                    node.emit('onMQTTConnect');
                    node.refreshDevices();
                });
                node.log('Broker registered')
            } else {
                node.error('Missing broker configuration')
            }

            node.on('close', done => this.onClose(done));

            // console.log(node.config._users);
        }

        refreshDevices() {
            const node = this;

            node.log('Requesting groups and devices lists');

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/groups",
                payload: ""
            });
            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/devices",
                payload: ""
            });
        }


        async getDevices(forceRefresh = false, withGroups = false) {
            const node = this;

            if (forceRefresh || node.devices === undefined) {
                node.refreshDevices();

                let timeoutHandle;
                try {
                    await Promise.race([
                        Promise.all([
                            once(node, 'onMQTTBridgeConfigGroups'),
                            once(node, 'onMQTTBridgeConfigDevices')
                        ]),
                        new Promise((resolve, reject) => {
                            timeoutHandle = setTimeout(() => {
                                node.error('Timeout waiting for devices update');
                                reject(new Error('timeout'));
                            }, 10_000);
                        })
                    ]);
                } finally {
                    clearTimeout(timeoutHandle);
                }
            } else {
                // console.log(node.devices);
                node.log('Using cached devices');
            }
            return withGroups ? [node.devices, node.groups] : node.devices;
        }


        getDeviceById(id) {
            const node = this;

            if (!node.devices) {
                return null;
            }

            for (let device of node.devices) {
                if (id === device['ieeeAddr']) {
                    const result = device;
                    result['lastPayload'] = {};
                    const topic = node.getBaseTopic() + '/' + (device['friendly_name'] || device['ieeeAddr']);
                    if (topic in node.devices_values) {
                        result['lastPayload'] = node.devices_values[topic];
                        result['homekit'] = payload2homekit(node.devices_values[topic], device)
                    }
                    return result;
                }
            }

            return null;
        }


        getGroupById(id) {
            const node = this;

            if (!node.groups) {
                return null;
            }

            for (let group of node.groups) {
                if (id === group['ID']) {
                    const result = group;
                    result['lastPayload'] = {};
                    const topic = node.getBaseTopic() + '/' + (group['friendly_name'] || group['ID']);
                    if (topic in node.devices_values) {
                        result['lastPayload'] = node.devices_values[topic];
                        result['homekit'] = payload2homekit(node.devices_values[topic], group)
                    }
                    return result;
                }
            }

            return null;
        }


        getLastStateById(id) {
            const node = this;

            const device = node.getDeviceById(id);
            if (device) {
                return device;
            }

            const group = node.getGroupById(id);
            if (group) {
                return group;
            }

            return null;
        }


        getDeviceByTopic(topic) {
            const node = this;

            if (!node.devices) {
                return null;
            }

            for (let device of node.devices) {
                if (topic === node.getBaseTopic() + '/' + device['friendly_name']
                    || topic === node.getBaseTopic() + '/' + device['ieeeAddr']
                ) {
                    return device;
                }
            }

            return null;
        }


        getGroupByTopic(topic) {
            const node = this;

            if (!node.groups) {
                return null;
            }

            for (let group of node.groups) {
                if (topic === node.getBaseTopic() + '/' + group['friendly_name']
                    || topic === node.getBaseTopic() + '/' + group['ID']
                ) {
                    return group;
                }
            }

            return null;
        }


        getBaseTopic() {
            return this.config.base_topic;
        }


        setLogLevel(val) {
            const node = this;

            if (['info', 'debug', 'warn', 'error'].indexOf(val) < 0) {
                val = 'info';
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/log_level",
                payload: val
            });
            node.log('Log Level set to: ' + val);
        }


        setPermitJoin(val) {
            const node = this;

            val = val ? "true" : "false";

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/permit_join",
                payload: val
            });
            node.log('Permit Join set to: ' + val);
        }


        renameDevice(ieeeAddr, newName) {
            const node = this;

            const device = node.getDeviceById(ieeeAddr);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            if (!newName.length)  {
                return {"error":true,"description":"can not be empty"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/rename",
                payload: JSON.stringify({
                    old: device.friendly_name,
                    new: newName
                })
            });
            node.log('Rename device ' + ieeeAddr + ' to ' + newName);

            return {"success":true,"description":"command sent"};
        }


        removeDevice(ieeeAddr) {
            const node = this;

            const device = node.getDeviceById(ieeeAddr);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/force_remove",
                payload: device.friendly_name
            });
            node.log('Remove device: ' + device.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        setDeviceOptions(friendly_name, options) {
            const node = this;

            // var device = node.getDeviceById(ieeeAddr);
            // if (!device) {
            //     return {"error":true,"description":"no such device"};
            // }

            const payload = JSON.stringify({
                friendly_name: friendly_name,
                options: options
            });

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/device_options",
                payload: payload
            });
            node.log('Set device options: ' + payload);

            return {"success":true,"description":"command sent"};
        }


        renameGroup(id, newName) {
            const node = this;

            const group = node.getGroupById(id);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            if (!newName.length) {
                return {"error":true,"description":"can not be empty"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/rename",
                payload: JSON.stringify({
                    old: group.friendly_name,
                    new: newName
                })
            });
            node.log('Rename group ' + id + ' to ' + newName);

            return {"success":true,"description":"command sent"};
        }


        removeGroup(id) {
            const node = this;

            const group = node.getGroupById(id);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/remove_group",
                payload: group.friendly_name
            });
            node.log('Remove group: ' + group.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        addGroup(name) {
            const node = this;

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/add_group",
                payload: name
            });
            node.log('Add group: ' + name);

            return {"success":true,"description":"command sent"};
        }


        removeDeviceFromGroup(deviceId, groupId) {
            const node = this;

            const device = node.getDeviceById(deviceId);
            if (!device) {
                device = {"friendly_name":deviceId};
            }

            const group = node.getGroupById(groupId);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/group/"+group.friendly_name+"/remove",
                payload: device.friendly_name
            });
            node.log('Removing device: '+device.friendly_name+' from group: '+group.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        addDeviceToGroup(deviceId, groupId) {
            const node = this;

            const device = node.getDeviceById(deviceId);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            const group = node.getGroupById(groupId);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/group/" + group.friendly_name + "/add",
                payload: device.friendly_name
            });
            node.log('Adding device: ' + device.friendly_name + ' to group: ' + group.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        async refreshMap(engine = null) {
            const node = this;

            node.log('Refreshing map and waiting...');
            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/networkmap",
                payload: "graphviz"
            });

            let timeoutHandle;
            let messages;
            try {
                messages = await Promise.race([
                    once(node, 'onMQTTBridgeNetworkGraphviz'),
                    new Promise((resolve, reject) => {
                        timeoutHandle = setTimeout(() => {
                            node.error('Timeout waiting for map update');
                            reject(new Error('timeout'));
                        }, 120_000);
                    })
                ]);
            } finally {
                clearTimeout(timeoutHandle);
            }

            const svg = await node.graphviz(messages[0], engine);
            return { "success": true, "svg": svg };
        }


        async graphviz(payload, engine = null) {
            const node = this;

            const options = {
                format: 'svg',
                engine: engine || 'circo'
            };
            const viz = new Viz({ Module, render });
            const svg = await viz.renderString(payload, options);
            node.map = svg;
            return svg;
        }


        onMQTTMessage(topic, payload, _packet) {
            const node = this;

            const payloadString = payload.toString();

            // node.log("Topic: " + topic + " Message: " + payloadString);

            if (topic.startsWith(node.getBaseTopic() + '/bridge/')) {
                let suppressPropagation = false;

                if (node.getBaseTopic() + '/bridge/state' === topic) {
                    node.bridge_state = payloadString;
                    if (node.bridge_state !== "online") {
                        node.error("bridge status: " + payloadString);
                    }
                    node.emit('onMQTTBridgeState', {
                        topic: topic,  // XXX
                        payload: node.bridge_state === "online"
                    });
                } else if (node.getBaseTopic() + '/bridge/config' === topic) {
                    node.bridge_config = JSON.parse(payloadString);
                } else if (node.getBaseTopic() + '/bridge/log' === topic) {
                    const logMessage = tryJson(payloadString);
                    if (logMessage) {
                        if ("type" in logMessage) {  // hasOwnProperty?
                            switch (logMessage.type) {
                                case "device_renamed":
                                case "device_announced":
                                case "device_removed":
                                case "group_renamed":
                                case "group_removed":
                                    node.refreshDevices();
                                    break;
                                case "group_added":
                                    node.setDeviceOptions(logMessage.message, {"retain": true});
                                    node.refreshDevices();
                                    break;
                                case "groups":
                                    node.log('Groups list updated');
                                    node.groups = logMessage.message;
                                    suppressPropagation = node.listenerCount('onMQTTBridgeConfigGroups') > 0;
                                    node.emit('onMQTTBridgeConfigGroups', node.groups);
                                    break;
                                case "devices":
                                    node.log('Devices list updated');
                                    node.devices = logMessage.message;
                                    suppressPropagation = node.listenerCount('onMQTTBridgeConfigDevices') > 0;
                                    node.emit('onMQTTBridgeConfigDevices', node.devices);
                                    break;
                                case "pairing":
                                    if ("interview_successful" === logMessage.message) {
                                        node.setDeviceOptions(logMessage.meta.friendly_name, {"retain": true})
                                    }
                                    break;
                            }
                        }
                    }
                } else if (node.getBaseTopic() + '/bridge/networkmap/graphviz' === topic) {
                    node.log('got graphviz message');
                    suppressPropagation = node.listenerCount('onMQTTBridgeNetworkGraphviz') > 0;
                    node.emit('onMQTTBridgeNetworkGraphviz', payloadString);
                }

                if (!suppressPropagation) {
                    node.emit('onMQTTMessageBridge', {
                        topic: topic,
                        payload: payloadString
                    });
                }
            } else {
                const payloadJson = tryJson(payloadString);

                if (payloadJson) {
                    if (topic.split('/')[2] !== 'set') {
                        //clone object for payload output
                        const payload = {};
                        Object.assign(payload, payloadJson);
                        node.devices_values[topic] = payloadJson;
                        node.emit('onMQTTMessage', {
                            topic: topic,
                            payload: payload,
                            device: node.getDeviceByTopic(topic),
                            group: node.getGroupByTopic(topic)
                        });
                    }
                } else {
                    node.warn('device data is not a valid JSON');
                }
            }
        }


        onClose(done) {
            const node = this;

            if (node.brokerConn) {
                node.brokerConn.unsubscribe(node.topic, node.id, removed);
                node.brokerConn.deregister(node, done);
                node.log('Broker unregistered');  // XXX: why this doesn't show up in logs on terminate?
            }

            node.emit('onClose');
            done();
        }
    }


    RED.nodes.registerType('zigbee2mqtt-server', ServerNode);
};
