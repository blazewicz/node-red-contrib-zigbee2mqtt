const Zigbee2mqttHelper = require('../lib/Zigbee2mqttHelper.js');
var Viz = require('viz.js');
var { once } = require('events');
var { Module, render } = require('viz.js/full.render.js');

module.exports = function (RED) {
    class ServerNode{
        constructor(n) {
            RED.nodes.createNode(this, n);

            var node = this;
            node.config = n;
            node.broker = node.config.broker;
            node.brokerConn = RED.nodes.getNode(node.broker);
            node.config.qos = node.config.qos || 2
            node.topic = node.config.base_topic+'/#';
            node.items = undefined;
            node.groups = undefined;
            node.devices = undefined;
            node.devices_values = [];
            node.bridge_config = null;
            node.bridge_state = null;
            node.map = null;
            node.on('close', done => this.onClose(done));

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


            // console.log(node.config._users);
        }

        refreshDevices() {
            var node = this;

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

        getDevices(callback, forceRefresh = false, withGroups = false) {
            var node = this;

            if (forceRefresh || node.devices === undefined) {
                Promise.all([
                    once(node, 'onMQTTBridgeConfigGroups'),
                    once(node, 'onMQTTBridgeConfigDevices')
                ]).then(() => {
                    callback(withGroups ? [node.devices, node.groups] : node.devices)
                });

                node.refreshDevices();
            } else {
                // console.log(node.devices);
                node.log('Using cached devices');
                if (typeof (callback) === "function") {
                    callback(withGroups?[node.devices, node.groups]:node.devices);
                }
                return withGroups?[node.devices, node.groups]:node.devices;
            }
        }


        getDeviceById(id) {
            var node = this;
            var result = null;
            for (var i in node.devices) {
                if (id == node.devices[i]['ieeeAddr']) {
                    result = node.devices[i];
                    result['lastPayload'] = {};

                    var topic =  node.getBaseTopic()+'/'+(node.devices[i]['friendly_name']?node.devices[i]['friendly_name']:node.devices[i]['ieeeAddr']);
                    if (topic in node.devices_values) {
                        result['lastPayload'] = node.devices_values[topic];
                        result['homekit'] = Zigbee2mqttHelper.payload2homekit(node.devices_values[topic], node.devices[i])
                    }
                    break;
                }
            }
            return result;
        }

        getGroupById(id) {
            var node = this;
            var result = null;
            for (var i in node.groups) {
                if (id == node.groups[i]['ID']) {
                    result = node.groups[i];
                    result['lastPayload'] = {};

                    var topic =  node.getBaseTopic()+'/'+(node.groups[i]['friendly_name']?node.groups[i]['friendly_name']:node.groups[i]['ID']);
                    if (topic in node.devices_values) {
                        result['lastPayload'] = node.devices_values[topic];
                        result['homekit'] = Zigbee2mqttHelper.payload2homekit(node.devices_values[topic], node.groups[i])
                    }
                    break;
                }
            }
            return result;
        }

        getLastStateById(id) {
            var node = this;
            var device = node.getDeviceById(id);
            if (device) {
                return device;
            }
            var group = node.getGroupById(id);
            if (group) {
                return group;
            }
            return {};
        }

        getDeviceByTopic(topic) {
            var node = this;
            var result = null;
            for (var i in node.devices) {
                if (topic == node.getBaseTopic()+'/'+node.devices[i]['friendly_name']
                    || topic == node.getBaseTopic()+'/'+node.devices[i]['ieeeAddr']) {
                    result = node.devices[i];
                    break;
                }
            }
            return result;
        }

        getGroupByTopic(topic) {
            var node = this;
            var result = null;
            for (var i in node.groups) {
                if (topic == node.getBaseTopic()+'/'+node.groups[i]['friendly_name']
                    || topic == node.getBaseTopic()+'/'+node.groups[i]['ID']) {
                    result = node.groups[i];
                    break;
                }
            }
            return result;
        }

        getBaseTopic() {
            return this.config.base_topic;
        }

        setLogLevel(val) {
            var node = this;
            if (['info', 'debug', 'warn', 'error'].indexOf(val) < 0) val = 'info';
            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/log_level",
                payload: val
            });
            node.log('Log Level set to: '+val);
        }

        setPermitJoin(val) {
            var node = this;
            val = val?"true":"false";
            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/permit_join",
                payload: val
            });
            node.log('Permit Join set to: '+val);
        }

        renameDevice(ieeeAddr, newName) {
            var node = this;

            var device = node.getDeviceById(ieeeAddr);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            if (!newName.length)  {
                return {"error":true,"description":"can not be empty"};
            }

            var payload = {
                "old":device.friendly_name,
                "new":newName
            };

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/rename",
                payload: JSON.stringify(payload)
            });
            node.log('Rename device '+ieeeAddr+' to '+newName);

            return {"success":true,"description":"command sent"};
        }

        removeDevice(ieeeAddr) {
            var node = this;

            var device = node.getDeviceById(ieeeAddr);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/force_remove",
                payload: device.friendly_name
            });
            node.log('Remove device: '+device.friendly_name);

            return {"success":true,"description":"command sent"};
        }

        setDeviceOptions(friendly_name, options) {
            var node = this;
            //
            // var device = node.getDeviceById(ieeeAddr);
            // if (!device) {
            //     return {"error":true,"description":"no such device"};
            // }

            var payload = {};
            payload['friendly_name'] = friendly_name;
            payload['options'] = options;


            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/device_options",
                payload: JSON.stringify(payload)
            });
            node.log('Set device options: '+JSON.stringify(payload));

            return {"success":true,"description":"command sent"};
        }


        renameGroup(id, newName) {
            var node = this;

            var group = node.getGroupById(id);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            if (!newName.length)  {
                return {"error":true,"description":"can not be empty"};
            }

            var payload = {
                "old":group.friendly_name,
                "new":newName
            };

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/rename",
                payload: JSON.stringify(payload)
            });
            node.log('Rename group '+id+' to '+newName);

            return {"success":true,"description":"command sent"};
        }

        removeGroup(id) {
            var node = this;

            var group = node.getGroupById(id);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/remove_group",
                payload: group.friendly_name
            });
            node.log('Remove group: '+group.friendly_name);

            return {"success":true,"description":"command sent"};
        }

        addGroup(name) {
            var node = this;

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/config/add_group",
                payload: name
            });
            node.log('Add group: '+name);

            return {"success":true,"description":"command sent"};
        }


        removeDeviceFromGroup(deviceId, groupId) {
            var node = this;

            var device = node.getDeviceById(deviceId);
            if (!device) {
                device = {"friendly_name":deviceId};
            }

            var group = node.getGroupById(groupId);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/group/"+group.friendly_name+"/remove",
                payload: device.friendly_name
            });
            node.log('Removing device: '+device.friendly_name  + ' from group: '+group.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        addDeviceToGroup(deviceId, groupId) {
            var node = this;


            var device = node.getDeviceById(deviceId);
            if (!device) {
                return {"error":true,"description":"no such device"};
            }

            var group = node.getGroupById(groupId);
            if (!group) {
                return {"error":true,"description":"no such group"};
            }

            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/group/" + group.friendly_name + "/add",
                payload: device.friendly_name
            });
            node.log('Adding device: '+device.friendly_name+ ' to group: '+group.friendly_name);

            return {"success":true,"description":"command sent"};
        }


        async refreshMap(engine = null) {
            var node = this;

            node.log('Refreshing map and waiting...');
            node.brokerConn.publish({
                topic: node.getBaseTopic() + "/bridge/networkmap",
                payload: 'graphviz'
            });
            var messages = await once(node, 'onMQTTBridgeNetworkGraphviz');
            var svg = await node.graphviz(messages[0], engine);
            return { "success": true, "svg": svg };
        }

        async graphviz(payload, engine = null) {
            var node = this;
            var options = {
                format:  'svg',
                engine: engine?engine:'circo'
            };
            var viz = new Viz({ Module, render });
            return node.map = await viz.renderString(payload,options);
        }


        onMQTTMessage(topic, payload, _packet) {
            var node = this;
            var messageString = payload.toString();


            //bridge
            if (topic.search(new RegExp(node.getBaseTopic()+'\/bridge\/')) === 0) {
                if (node.getBaseTopic() + '/bridge/state' == topic) {
                    node.bridge_state = messageString;
                    if (node.bridge_state != "online") {
                        node.error("bridge status: " + messageString);
                    }
                    node.emit('onMQTTBridgeState', {
                        topic: topic,
                        payload: messageString == "online"
                    });
                    if (message.toString() == "online") {
                        node.getDevices(null, true, true);
                    }
                } else if (node.getBaseTopic()+'/bridge/config' == topic) {
                    node.bridge_config = JSON.parse(messageString);

                } else if (node.getBaseTopic() + '/bridge/log' == topic) {
                    if (Zigbee2mqttHelper.isJson(messageString)) {
                        var payload = JSON.parse(messageString);
                        if ("type" in payload) {
                            switch (payload.type) {
                                case "device_renamed":
                                case "device_announced":
                                case "device_removed":
                                case "group_renamed":
                                case "group_removed":
                                    node.refreshDevices();
                                    break;
                                case "group_added":
                                    node.setDeviceOptions(payload.message, {"retain": true});
                                    node.refreshDevices();
                                    break;
                                case "groups":
                                    node.log('Groups list updated');
                                    node.groups = payload.message;
                                    node.emit('onMQTTBridgeConfigGroups', node.groups);
                                    break;
                                case "devices":
                                    node.log('Devices list updated');
                                    node.devices = payload.message;
                                    node.emit('onMQTTBridgeConfigDevices', node.devices);
                                    break;

                                case "pairing":
                                    if ("interview_successful" == payload.message) {
                                        node.setDeviceOptions(payload.meta.friendly_name, {"retain": true})
                                    }
                                    break;
                            }
                        }
                    }
                } else if (node.getBaseTopic() + '/bridge/networkmap/graphviz' == topic) {
                    node.emit('onMQTTBridgeNetworkGraphviz', messageString);
                }


                node.emit('onMQTTMessageBridge', {
                    topic:topic,
                    payload:messageString
                });
            } else {
                var payload_json = Zigbee2mqttHelper.isJson(messageString)?JSON.parse(messageString):messageString;

                //isSet
                if (topic.substring(topic.length - 4, topic.length) != '/set') {
                    //clone object for payload output
                    var payload = {};
                    Object.assign(payload, payload_json);
// console.log('==========MQTT START')
// console.log(topic);
// console.log(payload_json);
// console.log('==========MQTT END')
                    node.devices_values[topic] = payload_json;
                    node.emit('onMQTTMessage', {
                        topic: topic,
                        payload: payload,
                        device: node.getDeviceByTopic(topic),
                        group: node.getGroupByTopic(topic)
                    });
                }
            }
        }


        onClose(done) {
            var node = this;

            if (node.brokerConn) {
                node.brokerConn.unsubscribe(node.topic, node.id, removed);
                node.brokerConn.deregister(node, done);
                node.log('Broker unregistered');
            }

            node.emit('onClose');
            done();
        }
    }

    RED.nodes.registerType('zigbee2mqtt-server', ServerNode, {});
};

