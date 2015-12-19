const path = require("path"),
	array = require("retsu"),
	keysort = require("keysort"),
	url = require("url"),
	session = require("express-session"),
	cookie = require("cookie-parser"),
	lusca = require("lusca"),
	uuid = require("tiny-uuid4"),
	middleware = require(path.join(__dirname, "middleware.js")),
	regex = require(path.join(__dirname, "regex.js")),
	shared = require(path.join(__dirname, "shared.js")),
	passport = require("passport"),
	BasicStrategy = require("passport-http").BasicStrategy,
	BearerStrategy = require("passport-http-bearer").Strategy,
	FacebookStrategy = require("passport-facebook").Strategy,
	GoogleStrategy = require("passport-google").Strategy,
	LinkedInStrategy = require("passport-linkedin").Strategy,
	LocalStrategy = require("passport-local").Strategy,
	OAuth2Strategy = require("passport-oauth2").Strategy,
	SAMLStrategy = require("passport-saml").Strategy,
	TwitterStrategy = require("passport-twitter").Strategy,
	RedisStore = require("connect-redis")(session);

function trim (obj) {
	return obj.replace(/^(\s+|\t+|\n+)|(\s+|\t+|\n+)$/g, "");
}

function explode (obj, arg = ",") {
	return trim(obj).split(new RegExp("\\s*" + arg + "\\s*"));
}

function escape (arg) {
	return arg.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
}

function capitalize (obj, all = false) {
	let result;

	if (all) {
		result = explode(obj, " ").map(capitalize).join(" ");
	} else {
		result = obj.charAt(0).toUpperCase() + obj.slice(1);
	}

	return result;
}

function clone (arg) {
	return JSON.parse(JSON.stringify(arg));
}

function contains (haystack, needle) {
	return haystack.indexOf(needle) > -1;
}

function isEmpty (obj) {
	return trim(obj) === "";
}

function merge (a, b) {
	if (a instanceof Object && b instanceof Object) {
		Object.keys(b).forEach(function (i) {
			if (a[i] instanceof Object && b[i] instanceof Object) {
				a[i] = merge(a[i], b[i]);
			} else if (a[i] instanceof Array && b[i] instanceof Array) {
				a[i] = a[i].concat(b[i]);
			} else {
				a[i] = b[i];
			}
		});
	} else if (a instanceof Array && b instanceof Array) {
		a = a.concat(b);
	} else {
		a = b;
	}

	return a;
}

function auth (obj, config) {
	let ssl = config.ssl.cert && config.ssl.key,
		proto = "http" + (ssl ? "s" : ""),
		realm = proto + "://" + (config.hostname === "localhost" ? "127.0.0.1" : config.hostname) + (config.port !== 80 && config.port !== 443 ? ":" + config.port : ""),
		async = (config.auth.facebook.enabled || config.auth.google.enabled || config.auth.linkedin.enabled || config.auth.twitter.enabled) !== false,
		stateless = (config.auth.basic.enabled || config.auth.bearer.enabled) !== false,
		stateful = (async || config.auth.local.enabled || config.security.csrf) !== false,
		authMap = {},
		authUris = [],
		keys, sesh, fnCookie, fnSession, luscaCsp, luscaCsrf, luscaXframe, luscaP3p, luscaHsts, luscaXssProtection, passportAuth,
		passportInit, passportSession;

	function csrfWrapper (req, res, next) {
		if (req.unprotect) {
			next();
		} else {
			luscaCsrf(req, res, next);
		}
	}

	function init (sess) {
		passportInit = passport.initialize();
		obj.server.use(passportInit).blacklist(passportInit);

		if (sess) {
			passportSession = passport.session();
			obj.server.use(passportSession).blacklist(passportSession);
		}
	}

	function redirect (req, res) {
		res.redirect(config.auth.redirect);
	}

	obj.server.use(middleware.decorate).blacklist(middleware.decorate);
	obj.server.use(middleware.parse).blacklist(middleware.parse);

	obj.server.blacklist(middleware.asyncFlag);

	config.auth.protect = (config.auth.protect || []).map(function (i) {
		return new RegExp("^" + i !== "/login" ? i.replace(/\.\*/g, "*").replace(/\*/g, ".*") : "$", "i");
	});

	config.auth.unprotect = (config.auth.unprotect || []).map(function (i) {
		return new RegExp("^" + i !== "/login" ? i.replace(/\.\*/g, "*").replace(/\*/g, ".*") : "$", "i");
	});

	if (async) {
		shared.iterate(config.auth, function (v, k) {
			if (v.enabled) {
				authMap[k + "_uri"] = "/auth/" + k;
				config.auth.protect.push(new RegExp("^/auth/" + k));
			}
		});
	}

	authUris = Object.keys(authMap);

	if (config.auth.local.enabled) {
		authUris.push(config.auth.redirect);
		authUris.push("/login");
	}

	obj.server.use(middleware.valid).blacklist(middleware.valid);

	if (stateful) {
		sesh = {
			secret: config.session.secret || uuid(),
			saveUninitialized: true,
			rolling: true,
			resave: true
		};

		if (config.session.store === "redis") {
			sesh.store = new RedisStore(config.session.redis);
		}

		fnCookie = cookie();
		fnSession = session(sesh);

		obj.server.use(fnSession).blacklist(fnSession);
		obj.server.use(fnCookie).blacklist(fnCookie);
		obj.server.use(middleware.bypass).blacklist(middleware.bypass);

		if (config.security.csrf) {
			luscaCsrf = lusca.csrf({key: config.security.key, secret: config.security.secret});
			obj.server.use(csrfWrapper).blacklist(csrfWrapper);
		}
	}

	if (config.security.csp instanceof Object) {
		luscaCsp = lusca.csp(config.security.csp);
		obj.server.use(luscaCsp).blacklist(luscaCsp);
	}

	if (!isEmpty(config.security.xframe || "")) {
		luscaXframe = lusca.xframe(config.security.xframe);
		obj.server.use(luscaXframe).blacklist(luscaXframe);
	}

	if (!isEmpty(config.security.p3p || "")) {
		luscaP3p = lusca.p3p(config.security.p3p);
		obj.server.use(luscaP3p).blacklist(luscaP3p);
	}

	if (config.security.hsts instanceof Object) {
		luscaHsts = lusca.hsts(config.security.hsts);
		obj.server.use(luscaHsts).blacklist(luscaHsts);
	}

	if (config.security.xssProtection instanceof Object) {
		luscaXssProtection = lusca.xssProtection(config.security.xssProtection);
		obj.server.use(luscaXssProtection).blacklist(luscaXssProtection);
	}

	// Can fork to `middleware.keymaster()`
	obj.server.use(middleware.zuul).blacklist(middleware.zuul);

	if (stateless && !stateful) {
		init(false);
	} else {
		init(true);

		passport.serializeUser(function (user, done) {
			done(null, user);
		});

		passport.deserializeUser(function (arg, done) {
			done(null, arg);
		});

		if (authUris.length > 0) {
			keys = Object.keys(authMap).length > 0;

			if (keys) {
				config.routes.get["/auth"] = authMap;
			}

			(function () {
				let r = "(?!/auth/(";

				array.each(authUris, function (i) {
					r += i.replace("_uri", "") + "|";
				});

				r = r.replace(/\|$/, "") + ")).*$";

				obj.server.use(r, middleware.rate).blacklist(middleware.rate);
				obj.server.use(r, middleware.guard).blacklist(middleware.guard);
			}());

			config.routes.get["/login"] = config.auth.local.enabled ? keys ? {
				login_uri: "/auth",
				instruction: "POST 'username' & 'password' to authenticate"
			} : {instruction: "POST 'username' & 'password' to authenticate"} : {login_uri: "/auth"};
		} else if (config.auth.local.enabled) {
			config.routes.get["/login"] = {instruction: "POST 'username' & 'password' to authenticate"};
		}

		config.routes.get["/logout"] = function (req, res) {
			if (req.session) {
				req.session.destroy();
			}

			res.redirect(config.auth.redirect);
		};
	}

	if (config.auth.basic.enabled) {
		(function () {
			let x = {};

			function validate (arg, cb) {
				if (x[arg]) {
					cb(null, x[arg]);
				} else {
					cb(new Error("Unauthorized"), null);
				}
			}

			array.each(config.auth.basic.list || [], function (i) {
				let args = i.split(":");

				if (args.length > 0) {
					x[args[0]] = {password: args[1]};
				}
			});

			passport.use(new BasicStrategy(function (username, password, done) {
				validate(username, function (err, user) {
					if (err) {
						delete err.stack;
						return done(err);
					}

					if (!user || user.password !== password) {
						return done(null, false);
					}

					return done(null, user);
				});
			}));

			passportAuth = passport.authenticate("basic", {session: stateful});

			if (async || config.auth.local.enabled) {
				obj.server.get("/auth/basic", passportAuth).blacklist(passportAuth);
				obj.server.get("/auth/basic", redirect);
			} else {
				obj.server.use(passportAuth).blacklist(passportAuth);
			}
		}());
	}

	if (config.auth.bearer.enabled) {
		(function () {
			let x = config.auth.bearer.tokens || [];

			function validate (arg, cb) {
				if (array.contains(x, arg)) {
					cb(null, arg);
				} else {
					cb(new Error("Unauthorized"), null);
				}
			}

			passport.use(new BearerStrategy(function (token, done) {
				validate(token, function (err, user) {
					if (err) {
						delete err.stack;
						return done(err);
					}

					if (!user) {
						return done(null, false);
					}

					return done(null, user, {scope: "read"});
				});
			}));

			middleware.passportAuth = passport.authenticate("bearer", {session: stateful});

			if (async || config.auth.local.enabled) {
				obj.server.get("/auth/bearer", middleware.passportAuth).blacklist(middleware.passportAuth);
				obj.server.get("/auth/bearer", redirect);
			} else {
				obj.server.use(middleware.passportAuth).blacklist(middleware.passportAuth);
			}
		}());
	}

	if (config.auth.facebook.enabled) {
		passport.use(new FacebookStrategy({
			clientID: config.auth.facebook.client_id,
			clientSecret: config.auth.facebook.client_secret,
			callbackURL: realm + "/auth/facebook/callback"
		}, function (accessToken, refreshToken, profile, done) {
			config.auth.facebook.auth(accessToken, refreshToken, profile, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		obj.server.get("/auth/facebook", middleware.asyncFlag);
		obj.server.get("/auth/facebook", passport.authenticate("facebook"));
		obj.server.get("/auth/facebook/callback", middleware.asyncFlag);
		obj.server.get("/auth/facebook/callback", passport.authenticate("facebook", {failureRedirect: "/login"}));
		obj.server.get("/auth/facebook/callback", redirect);
	}

	if (config.auth.google.enabled) {
		passport.use(new GoogleStrategy({
			returnURL: realm + "/auth/google/callback",
			realm: realm
		}, function (identifier, profile, done) {
			config.auth.google.auth.call(obj, identifier, profile, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		obj.server.get("/auth/google", middleware.asyncFlag);
		obj.server.get("/auth/google", passport.authenticate("google"));
		obj.server.get("/auth/google/callback", middleware.asyncFlag);
		obj.server.get("/auth/google/callback", passport.authenticate("google", {failureRedirect: "/login"}));
		obj.server.get("/auth/google/callback", redirect);
	}

	if (config.auth.linkedin.enabled) {
		passport.use(new LinkedInStrategy({
			consumerKey: config.auth.linkedin.client_id,
			consumerSecret: config.auth.linkedin.client_secret,
			callbackURL: realm + "/auth/linkedin/callback"
		}, function (token, tokenSecret, profile, done) {
			config.auth.linkedin.auth(token, tokenSecret, profile, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		obj.server.get("/auth/linkedin", middleware.asyncFlag);
		obj.server.get("/auth/linkedin", passport.authenticate("linkedin", {"scope": config.auth.linkedin.scope || ["r_basicprofile", "r_emailaddress"]}));
		obj.server.get("/auth/linkedin/callback", middleware.asyncFlag);
		obj.server.get("/auth/linkedin/callback", passport.authenticate("linkedin", {failureRedirect: "/login"}));
		obj.server.get("/auth/linkedin/callback", redirect);
	}

	if (config.auth.local.enabled) {
		passport.use(new LocalStrategy(function (username, password, done) {
			config.auth.local.auth(username, password, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		config.routes.post = config.routes.post || {};
		config.routes.post["/login"] = function (req, res) {
			function final () {
				passport.authenticate("local")(req, res, function (e) {
					if (e) {
						res.error(401, "Unauthorized");
					} else if (req.cors && req.headers["x-requested-with"] && req.headers["x-requested-with"] === "XMLHttpRequest") {
						res.respond("Success");
					} else {
						res.redirect(config.auth.redirect);
					}
				});
			}

			function mid () {
				middleware.passportSession(req, res, final);
			}

			middleware.passportInit(req, res, mid);
		};
	}

	if (config.auth.oauth2.enabled) {
		passport.use(new OAuth2Strategy({
			authorizationURL: config.auth.oauth2.auth_url,
			tokenURL: config.auth.oauth2.token_url,
			clientID: config.auth.oauth2.client_id,
			clientSecret: config.auth.oauth2.client_secret,
			callbackURL: realm + "/auth/oauth2/callback"
		}, function (accessToken, refreshToken, profile, done) {
			config.auth.oauth2.auth(accessToken, refreshToken, profile, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		obj.server.get("/auth/oauth2", middleware.asyncFlag);
		obj.server.get("/auth/oauth2", passport.authenticate("oauth2"));
		obj.server.get("/auth/oauth2/callback", middleware.asyncFlag);
		obj.server.get("/auth/oauth2/callback", passport.authenticate("oauth2", {failureRedirect: "/login"}));
		obj.server.get("/auth/oauth2/callback", redirect);
	}

	if (config.auth.saml.enabled) {
		(function () {
			let arg = config.auth.saml;

			arg.callbackURL = realm + "/auth/saml/callback";
			delete arg.enabled;
			delete arg.path;

			passport.use(new SAMLStrategy(arg, function (profile, done) {
				config.auth.saml.auth(profile, function (err, user) {
					if (err) {
						delete err.stack;
						return done(err);
					}

					done(null, user);
				});
			}));
		}());

		obj.server.get("/auth/saml", middleware.asyncFlag);
		obj.server.get("/auth/saml", passport.authenticate("saml"));
		obj.server.get("/auth/saml/callback", middleware.asyncFlag);
		obj.server.get("/auth/saml/callback", passport.authenticate("saml", {failureRedirect: "/login"}));
		obj.server.get("/auth/saml/callback", redirect);
	}

	if (config.auth.twitter.enabled) {
		passport.use(new TwitterStrategy({
			consumerKey: config.auth.twitter.consumer_key,
			consumerSecret: config.auth.twitter.consumer_secret,
			callbackURL: realm + "/auth/twitter/callback"
		}, function (token, tokenSecret, profile, done) {
			config.auth.twitter.auth(token, tokenSecret, profile, function (err, user) {
				if (err) {
					delete err.stack;
					return done(err);
				}

				done(null, user);
			});
		}));

		obj.server.get("/auth/twitter", middleware.asyncFlag);
		obj.server.get("/auth/twitter", passport.authenticate("twitter"));
		obj.server.get("/auth/twitter/callback", middleware.asyncFlag);
		obj.server.get("/auth/twitter/callback", passport.authenticate("twitter", {
			successRedirect: config.auth.redirect,
			failureRedirect: "/login"
		}));
	}

	return config;
}

function bootstrap (obj, config) {
	let notify = false;

	// Bootstrapping configuration
	auth(obj, config);

	// Setting headers
	config.headers = config.headers || {};
	config.headers.server = "tenso/{{VERSION}}";

	// Creating status > message map
	shared.iterate(obj.server.codes, function (value, key) {
		obj.messages[value] = obj.server.messages[key];
	});

	// Setting routes
	shared.iterate(config.routes, function (routes, method) {
		shared.iterate(routes, function (arg, route) {
			if (typeof arg === "function") {
				obj.server[method](route, function (...args) {
					arg.apply(obj, args);
				});
			} else {
				obj.server[method](route, function (req, res) {
					res.send(arg);
				});
			}
		});
	});

	// Disabling compression over SSL due to BREACH
	if (config.ssl.cert && config.ssl.key) {
		config.compress = false;
		notify = true;
	}

	// Starting API server
	obj.server.start(config, function (req, res, status, msg) {
		let stat = status instanceof Error ? parseInt(status.message, 10) : status,
			err = msg instanceof Error ? msg : new Error(msg || obj.messages[stat]);

		obj.error(req, res, stat, err);
	});

	if (notify) {
		obj.server.log("Compression over SSL is disabled for your protection", "debug");
	}

	return obj;
}

function queryString (qstring = "") {
	let obj = {};
	let aresult = qstring.split("?");
	let result;

	if (aresult.length > 1) {
		aresult.shift();
	}

	result = aresult.join("?");
	result.split("&").forEach(function (prop) {
		let aitem = prop.replace(/\+/g, " ").split("=");
		let item;

		if (aitem.length > 2) {
			item = [aitem.shift(), aitem.join("=")];
		} else {
			item = aitem;
		}

		if (isEmpty(item[0])) {
			return;
		}

		if (item[1] === undefined) {
			item[1] = "";
		} else {
			item[1] = shared.coerce(decodeURIComponent(item[1]));
		}

		if (obj[item[0]] === undefined) {
			obj[item[0]] = item[1];
		} else if (obj[item[0]] instanceof Array === false) {
			obj[item[0]] = [obj[item[0]]];
			obj[item[0]].push(item[1]);
		} else {
			obj[item[0]].push(item[1]);
		}
	});

	return obj;
}

function parse (uri) {
	let luri = uri;
	let idxAscii, idxQ, parsed;

	if (luri === undefined || luri === null) {
		luri = "";
	} else {
		idxAscii = luri.indexOf("%3F");
		idxQ = luri.indexOf("?");

		switch (true) {
			case idxQ === -1 && idxAscii > -1:
			case idxAscii < idxQ:
				luri = luri.replace("%3F", "?");
				break;
			default:
				void 0;
		}
	}

	parsed = url.parse(luri);
	parsed.query = parsed.search ? queryString(parsed.search) : {};

	shared.iterate(parsed, function (v, k) {
		if (v === null) {
			parsed[k] = "";
		}
	});

	return parsed;
}

function hypermedia (server, req, rep, headers) {
	let seen = {},
		collection = req.parsed.pathname,
		query, page, page_size, nth, root, parent;

	// Parsing the object for hypermedia properties
	function marshal (obj, rel, item_collection) {
		let keys = Object.keys(obj),
			lrel = rel || "related",
			result;

		if (keys.length === 0) {
			result = null;
		} else {
			array.each(keys, function (i) {
				let lcollection, uri;

				// If ID like keys are found, and are not URIs, they are assumed to be root collections
				if (regex.id.test(i) || regex.hypermedia.test(i)) {
					if (!regex.id.test(i)) {
						lcollection = i.replace(regex.trailing, "").replace(regex.trailing_s, "").replace(regex.trailing_y, "ie") + "s";
						lrel = "related";
					} else {
						lcollection = item_collection;
						lrel = "item";
					}

					uri = regex.scheme.test(obj[i]) ? obj[i] : "/" + lcollection + "/" + obj[i];

					if (uri !== root && !seen[uri]) {
						seen[uri] = 1;

						if (server.allowed("get", uri, req.vhost)) {
							rep.links.push({uri: uri, rel: lrel});
						}
					}
				}
			});

			result = obj;
		}

		return result;
	}

	if (rep.status >= 200 && rep.status <= 206) {
		query = req.parsed.query;
		page = query.page || 1;
		page_size = query.page_size || server.config.pageSize || 5;
		root = req.parsed.pathname;

		if (req.parsed.pathname !== "/") {
			rep.links.push({
				uri: root.replace(regex.trailing_slash, "").replace(regex.collection, "$1") || "/",
				rel: "collection"
			});
		}

		if (rep.data instanceof Array) {
			if (req.method === "GET") {
				if (isNaN(page) || page <= 0) {
					page = 1;
				}

				nth = Math.ceil(rep.data.length / page_size);

				if (nth > 1) {
					rep.data = array.limit(rep.data, (page - 1) * page_size, page_size);
					query.page = 0;
					query.page_size = page_size;

					root += "?" + Object.keys(query).map(function (i) {
							return i + "=" + encodeURIComponent(query[i]);
						}).join("&");

					if (page > 1) {
						rep.links.push({uri: root.replace("page=0", "page=1"), rel: "first"});
					}

					if (page - 1 > 1 && page <= nth) {
						rep.links.push({uri: root.replace("page=0", "page=" + (page - 1)), rel: "prev"});
					}

					if (page + 1 < nth) {
						rep.links.push({uri: root.replace("page=0", "page=" + (page + 1)), rel: "next"});
					}

					if (nth > 0 && page !== nth) {
						rep.links.push({uri: root.replace("page=0", "page=" + nth), rel: "last"});
					}
				} else {
					root += "?" + Object.keys(query).map(function (i) {
							return i + "=" + encodeURIComponent(query[i]);
						}).join("&");
				}
			}

			array.each(rep.data, function (i) {
				var li = i.toString(),
					uri;

				if (li !== collection) {
					uri = li.indexOf("//") > -1 || li.indexOf("/") === 0 ? li : (collection + "/" + li).replace(/^\/\//, "/");

					if (server.allowed("get", uri, req.vhost)) {
						rep.links.push({uri: uri, rel: "item"});
					}
				}

				if (i instanceof Object) {
					parse(i, "item", req.parsed.pathname.replace(regex.trailing_slash, "").replace(regex.leading, ""));
				}
			});
		} else if (rep.data instanceof Object) {
			parent = req.parsed.pathname.split("/").filter(function (i) {
				return i !== "";
			});

			if (parent.length > 1) {
				parent.pop();
			}

			rep.data = marshal(rep.data, undefined, array.last(parent));
		}

		if (rep.links.length > 0) {
			headers.link = keysort(rep.links, "rel, uri").map(function (i) {
				return "<" + i.uri + ">; rel=\"" + i.rel + "\"";
			}).join(", ");
		}
	}

	return rep;
}

module.exports = {
	auth: auth,
	bootstrap: bootstrap,
	capitalize: capitalize,
	clone: clone,
	contains: contains,
	explode: explode,
	escape: escape,
	hypermedia: hypermedia,
	isEmpty: isEmpty,
	merge: merge,
	queryString: queryString,
	parse: parse,
	trim: trim
};
