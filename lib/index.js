'use strict';

const Joi = require('joi');
const Path = require('path');
const Glob = require('glob');
const Async = require('async');
const apps = {};
const binds = {};
const methods = {};
const internals = {};

internals.injectObjectSchema = Joi.object().keys({
    prefix: Joi.string().optional(),
    includes: Joi.array().items(Joi.string(), Joi.object(), Joi.func()).required(),
    ignores: Joi.array().items(Joi.string()).optional(),
    options: Joi.object().keys({
        bind: Joi.object().optional(),
        cache: Joi.object().optional(),
        generateKey: Joi.func().optional(),
        callback: Joi.boolean().optional(),
        override: Joi.boolean().optional(),
        merge: Joi.boolean().optional()
    }).optional()
});

internals.injectArraySchema = Joi.array().items(internals.injectObjectSchema);

internals.optionsSchema = Joi.object().keys({
    relativeTo: Joi.string().optional(),
    routes: internals.injectArraySchema.optional(),
    handlers: internals.injectArraySchema.optional(),
    methods: internals.injectArraySchema.optional(),
    binds: internals.injectArraySchema.optional(),
    apps: internals.injectArraySchema.optional()
});


exports.register = (server, options, next) => {

    const validateOptions = internals.optionsSchema.validate(options);
    if (validateOptions.error) {
        return next(validateOptions.error);
    }

    const relativeTo = options.relativeTo || process.cwd();

    const runGlob = (globPattern, ignorePatterns, doneRun) => {

        return Glob(globPattern, {
            nodir: true,
            strict: true,
            ignore: ignorePatterns,
            cwd: relativeTo
        }, (err, files) => {

            let error;

            if (!files.length && !err) {
                error = 'Unable to retrieve files from pattern: ' + globPattern;
            }

            return doneRun(error, files);
        });
    };

    const getItems = (injectItem, doneGet) => {

        let itemsArr = [];

        return Async.each(injectItem.includes, (include, nextInclude) => {

            if (Joi.string().validate(include).error) {

                itemsArr.push(include);

                return nextInclude();
            }

            return runGlob(include, injectItem.ignores, (err, files) => {

                itemsArr = itemsArr.concat(files);

                return nextInclude(err);
            });

        }, (err) => {

            return doneGet(err, itemsArr);
        });
    };

    const buildOptions = (configOptions, injectOptions) => {
        let methodOpts = {};
        let override = false;
        let merge = false;

        if (configOptions) {
            merge = configOptions.merge;
            override = configOptions.override;
        }

        if (injectOptions && !configOptions) {
            methodOpts = injectOptions;
        }
        else if (configOptions && (!injectOptions || override && !merge)) {
            const configKeys = Object.keys(configOptions);

            for (let i = 0; i < configKeys.length; ++i) {
                const ckey = configKeys[i];

                if (ckey !== 'override' && ckey !== 'merge') {
                    methodOpts[ckey] = configOptions[ckey];
                }
            }
        }
        else if (configOptions && injectOptions) {
            if (merge) {
                const options = Object.keys(injectOptions).concat(Object.keys(configOptions));

                for (let i = 0; i < options.length; ++i) {
                    const option = options[i];

                    if (option !== 'override' && option !== 'merge'
                        && !methodOpts.hasOwnProperty(option)) {
                        const fromMethod = injectOptions[option];
                        const fromConfig = configOptions[option];

                        if (!fromMethod || override && fromConfig) {
                            methodOpts[option] = fromConfig;
                        }
                        else {
                            methodOpts[option] = fromMethod;
                        }
                    }
                }
            }
            else {
                methodOpts = injectOptions;
            }
        }

        return methodOpts;
    };

    const methodInjectHelper = (methodsFilename, methodPrefix, methodOptions, injectModuleValue, injectModuleKey) => {

        const moduleKey = (injectModuleKey) ? '.' + injectModuleKey : '';
        const modPrefix = (methodPrefix) ? methodPrefix + '.' : '';
        const methodName = modPrefix + methodsFilename + moduleKey;
        let methodValue;

        if (!Joi.func().validate(injectModuleValue).error) {
            methodValue = injectModuleValue;
        }
        else if (injectModuleValue.method && !Joi.func().validate(injectModuleValue.method).error) {
            methodValue = injectModuleValue.method;
        }

        if (methodValue) {
            server.method(methodName, methodValue, buildOptions(methodOptions, injectModuleValue.options));

            if (injectModuleKey && methodPrefix) {
                methods[methodPrefix][methodsFilename][injectModuleKey] = server.methods[methodPrefix][methodsFilename][injectModuleKey];
            }
            else if (injectModuleKey && !methodPrefix) {
                methods[methodsFilename][injectModuleKey] = server.methods[methodsFilename][injectModuleKey];
            }
            else if (methodPrefix && !injectModuleKey) {
                methods[methodPrefix][methodsFilename] = server.methods[methodPrefix][methodsFilename];
            }
            else {
                methods[methodsFilename] = server.methods[methodsFilename];
            }
        }
    };

    const appInject = (nextInject) => {

        return Async.each(options.apps, (injectItem, nextInjectItem) => {

            getItems(injectItem, (err, items) => {

                if (err) {
                    return nextInjectItem(err);
                }

                return Async.each(items, (item, nextFile) => {

                    let injectModule;
                    let appName;

                    if (Joi.string().validate(item).error) {
                        injectModule = item;
                    }
                    else {
                        injectModule = require(relativeTo + '/' + item);
                        appName = Path.basename(item, Path.extname(item));
                    }

                    if (!Joi.func().validate(injectModule).error) {

                        if (injectModule.name) {
                            appName = item.name;
                        }

                        if (!appName) {

                            return nextFile('Unable to identify the app name. Please refer to app loading api.');
                        }

                        server.app[appName] = injectModule;
                        apps[appName] = server.app[appName];

                        return nextFile(err);
                    }

                    return Async.forEachOf(injectModule, (injectModuleValue, injectModuleKey, nextInjectModuleKey) => {

                        server.app[injectModuleKey] = injectModuleValue;
                        apps[injectModuleKey] = server.app[injectModuleKey];

                        return nextInjectModuleKey();
                    }, (err) => {

                        return nextFile(err);
                    });

                }, (err) => {

                    return nextInjectItem(err);
                });
            });
        }, (err) => {

            return nextInject(err);
        });
    };

    const bindInject = (nextInject) => {

        return Async.each(options.binds, (injectItem, nextInjectItem) => {

            getItems(injectItem, (err, items) => {

                if (err) {
                    return nextInjectItem(err);
                }

                return Async.each(items, (item, nextFile) => {

                    let injectModule;
                    let bindName;

                    if (Joi.string().validate(item).error) {
                        injectModule = item;
                    }
                    else {
                        injectModule = require(relativeTo + '/' + item);
                        bindName = Path.basename(item, Path.extname(item));
                    }

                    if (!Joi.func().validate(injectModule).error) {

                        if (injectModule.name) {
                            bindName = item.name;
                        }

                        if (!bindName) {

                            return nextFile('Unable to identify the bind name. Please refer to bind loading api.');
                        }

                        binds[bindName] = injectModule;

                        return nextFile(err);
                    }

                    return Async.forEachOf(injectModule, (injectModuleValue, injectModuleKey, nextInjectModuleKey) => {

                        binds[injectModuleKey] = injectModuleValue;

                        return nextInjectModuleKey();
                    }, (err) => {

                        return nextFile(err);
                    });

                }, (err) => {

                    return nextInjectItem(err);
                });
            });
        }, (err) => {

            if (Object.keys(binds).length) {
                server.bind(binds);
            }

            return nextInject(err);
        });
    };

    const methodInject = (nextInject) => {

        return Async.each(options.methods, (injectItem, nextInjectItem) => {

            getItems(injectItem, (err, items) => {

                if (err) {
                    return nextInjectItem(err);
                }

                if (injectItem.prefix) {
                    methods[injectItem.prefix] = {};
                }

                return Async.each(items, (item, nextFile) => {

                    let injectModule;
                    let methodsFilename;

                    if (Joi.string().validate(item).error) {
                        injectModule = item;

                        if (item.name || item.method) {
                            methodsFilename = item.name || item.method.name;
                        }
                    }
                    else {
                        injectModule = require(relativeTo + '/' + item);
                        methodsFilename = Path.basename(item, Path.extname(item));
                    }

                    if (!methodsFilename) {

                        return nextFile('Unable to identify method name. Please refer to method loading API.');
                    }

                    if (injectItem.prefix) {
                        methods[injectItem.prefix][methodsFilename] = {};
                    }
                    else {
                        methods[methodsFilename] = {};
                    }

                    if (!Joi.func().validate(injectModule).error || injectModule.options) {

                        methodInjectHelper(methodsFilename, injectItem.prefix, injectItem.options, injectModule);

                        return nextFile(err);
                    }

                    return Async.forEachOf(injectModule, (injectModuleValue, injectModuleKey, nextInjectModuleKey) => {

                        methodInjectHelper(methodsFilename, injectItem.prefix, injectItem.options, injectModuleValue, injectModuleKey);

                        return nextInjectModuleKey();
                    }, (err) => {

                        return nextFile(err);
                    });

                }, (err) => {

                    return nextInjectItem(err);
                });
            });
        }, (err) => {

            return nextInject(err);
        });
    };

    const handlerInject = (nextInject) => {

        return Async.each(options.handlers, (injectItem, nextInjectItem) => {

            getItems(injectItem, (err, items) => {

                if (err) {
                    return nextInjectItem(err);
                }

                return Async.each(items, (item, nextFile) => {

                    if (Joi.string().validate(item).error) {
                        server.handler(item.name, item);
                    }
                    else {
                        server.handler(Path.basename(item, Path.extname(item)), require(relativeTo + '/' + item));
                    }

                    return nextFile();
                }, (err) => {

                    return nextInjectItem(err);
                });
            });
        }, (err) => {

            return nextInject(err);
        });
    };

    const routeInject = (nextInject) => {

        return Async.each(options.routes, (injectItem, nextInjectItem) => {

            getItems(injectItem, (err, items) => {

                if (err) {
                    return nextInjectItem(err);
                }

                return Async.each(items, (item, nextFile) => {

                    if (Joi.string().validate(item).error) {
                        server.route(item);
                    }
                    else {
                        server.route(require(relativeTo + '/' + item));
                    }

                    return nextFile();
                }, (err) => {

                    return nextInjectItem(err);
                });
            });
        }, (err) => {

            return nextInject(err);
        });
    };

    return Async.series([
        (done) => {

            return appInject((err) => {

                return done(err);
            });
        },
        (done) => {

            return bindInject((err) => {

                return done(err);
            });
        },
        (done) => {

            return methodInject((err) => {

                return done(err);
            });
        },
        (done) => {

            return handlerInject((err) => {

                return done(err);
            });
        },
        (done) => {

            return routeInject((err) => {

                return done(err);
            });
        }
    ], (err) => {

        return next(err);
    });
};


exports.apps = apps;


exports.binds = binds;


exports.methods = methods;


exports.register.attributes = {
    pkg: require('../package.json')
};
