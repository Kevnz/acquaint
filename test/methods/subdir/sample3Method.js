'use strict';

const Plugin = require('../../../');

exports.useAdd = (x, y) => {

    return Plugin.methods.sample2Method.add(x, y);
};
