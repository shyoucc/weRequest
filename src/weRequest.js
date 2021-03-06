const loading = require('./loading');

//params
var sessionName    = "session";
var loginTrigger   = function () {
    return false
};
var codeToSession  = {};
var successTrigger = function () {
    return true
};
var urlPerfix      = "";
var successData    = function (res) {
    return res
};
var errorTitle     = "操作失败";
var errorContent   = function (res) {
    return res
};
var reLoginLimit   = 3;
var errorCallback  = null;
var reportCGI      = false;
var mockJson       = false;
var globalData     = false;

//global data
var session           = '';
var sessionIsFresh    = false;
// 正在登录中，其他请求轮询稍后，避免重复调用登录接口
var logining          = false;
// 正在查询session有效期中，避免重复调用接口
var isCheckingSession = false;

function checkSession(callback, obj) {
    if (isCheckingSession) {
        setTimeout(function () {
            checkSession(callback, obj)
        }, 500);
    } else if (!sessionIsFresh && session) {
        isCheckingSession = true;
        obj.count++;
        // 如果还没检验过session是否有效，则需要检验一次
        obj._checkSessionStartTime = new Date().getTime();
        wx.checkSession({
            success: function () {
                // 登录态有效，且在本生命周期内无须再检验了
                sessionIsFresh = true;
            },
            fail: function () {
                // 登录态过期
                session = '';
            },
            complete: function () {
                isCheckingSession = false;
                obj.count--;
                obj._checkSessionEndTime = new Date().getTime();
                if (typeof reportCGI === "function") {
                    reportCGI('wx_checkSession', obj._checkSessionStartTime, obj._checkSessionEndTime, request);
                }
                doLogin(callback, obj);
            }
        })
    } else {
        // 已经检验过了
        doLogin(callback, obj);
    }
}

function doLogin(callback, obj) {
    if (session || obj.isLogin) {
        // 缓存中有session，或者是登录接口
        typeof callback === "function" && callback();
    } else if (logining) {
        // 正在登录中，请求轮询稍后，避免重复调用登录接口
        setTimeout(function () {
            doLogin(callback, obj);
        }, 500)
    } else {
        // 缓存中无session
        logining = true;
        obj.count++;
        // 记录调用wx.login前的时间戳
        obj._loginStartTime = new Date().getTime();
        wx.login({
            complete: function () {
                obj.count--;
                // 记录wx.login返回数据后的时间戳，用于上报
                obj._loginEndTime = new Date().getTime();
                if (typeof reportCGI === "function") {
                    reportCGI('wx_login', obj._loginStartTime, obj._loginEndTime, request);
                }
                typeof obj.complete === "function" && obj.count == 0 && obj.complete();
            },
            success: function (res) {
                if (res.code) {
                    var data;
                    // codeToSession.data支持函数
                    if (typeof codeToSession.data === "function") {
                        data = codeToSession.data();
                    } else {
                        data = codeToSession.data || {};
                    }
                    data[codeToSession.codeName] = res.code;

                    obj.count++;
                    requestWrapper({
                        url: codeToSession.url,
                        data: data,
                        method: codeToSession.method,
                        isLogin: true,
                        report: codeToSession.report || codeToSession.url,
                        success: function (s) {
                            session        = s;
                            sessionIsFresh = true;
                            typeof callback === "function" && callback();
                            wx.setStorage({
                                key: sessionName,
                                data: session
                            })
                        },
                        complete: function () {
                            obj.count--;
                            typeof obj.complete === "function" && obj.count == 0 && obj.complete();
                            logining = false;
                        },
                        fail: codeToSession.fail || null
                    });
                } else {
                    fail(obj, res);
                    console.error(res);
                    // 登录失败，解除锁，防止死锁
                    logining = false;
                }
            },
            fail: function (res) {
                fail(obj, res);
                console.error(res);
                // 登录失败，解除锁，防止死锁
                logining = false;
            }
        })
    }
}

function preDo(obj) {
    typeof obj.beforeSend === "function" && obj.beforeSend();

    // 登录态失效，重复登录计数
    if (typeof obj.reLoginLimit === "undefined") {
        obj.reLoginLimit = 0;
    } else {
        obj.reLoginLimit++;
    }

    if (typeof obj.count === "undefined") {
        obj.count = 0;
    }

    if (obj.showLoading) {
        loading.show();
        obj.complete = (function (fn) {
            return function () {
                loading.hide();
                typeof fn === "function" && fn.apply(this, arguments);
            }
        })(obj.complete)
    }

    return obj;
}

function request(obj) {
    obj.count++;

    if (!obj.data) {
        obj.data = {};
    }

    if (obj.url != codeToSession.url && session) {
        obj.data[sessionName] = session;
    }

    // 如果有全局参数，则添加
    var gd = {};
    if (typeof globalData === "function") {
        gd = globalData();
    } else if (typeof globalData === "object") {
        gd = globalData;
    }
    obj.data = Object.assign({}, gd, obj.data);

    obj.method = obj.method || 'GET';

    // 如果请求的URL中不是http开头的，则自动添加配置中的前缀
    var url = obj.url.startsWith('http') ? obj.url : (urlPerfix + obj.url);
    // 如果请求不是GET，则在URL中自动加上登录态和全局参数
    if (obj.method != "GET") {

        if (session) {
            if (url.indexOf('?') >= 0) {
                url += '&' + sessionName + '=' + session;
            } else {
                url += '?' + sessionName + '=' + session;
            }
        }

        // 如果有全局参数，则在URL中添加
        for (var i in gd) {
            if (url.indexOf('?') >= 0) {
                url += '&' + i + '=' + gd[i];
            } else {
                url += '?' + i + '=' + gd[i];
            }
        }
    }

    // 如果有上报字段配置，则记录请求发出前的时间戳
    if (obj.report) {
        obj._reportStartTime = new Date().getTime();
    }

    wx.request({
        url: url,
        data: obj.data,
        method: obj.method,
        header: obj.header || {},
        dataType: obj.dataType || 'json',
        success: function (res) {
            if (res.statusCode == 200) {

                // 如果有上报字段配置，则记录请求返回后的时间戳，并进行上报
                if (obj.report && typeof reportCGI === "function") {
                    obj._reportEndTime = new Date().getTime();
                    reportCGI(obj.report, obj._reportStartTime, obj._reportEndTime, request);
                }

                if (obj.isLogin) {
                    // 登录请求
                    var s = "";
                    try {
                        s = codeToSession.success(res.data);
                    } catch (e) {
                    }
                    if (s) {
                        obj.success(s);
                    } else {
                        fail(obj, res);
                    }
                } else if (loginTrigger(res.data) && obj.reLoginLimit < reLoginLimit) {
                    // 登录态失效，且重试次数不超过配置
                    session = '';
                    wx.removeStorage({
                        key: sessionName,
                        complete: function () {
                            doLogin(function () {
                                requestWrapper(obj);
                            }, obj)
                        }
                    })
                } else if (successTrigger(res.data) && typeof obj.success === "function") {
                    // 接口返回成功码
                    var realData = null;
                    try {
                        realData = successData(res.data);
                    } catch (e) {
                        console.error("Function successData occur error: " + e);
                    }
                    obj.success(realData);
                    if (obj.cache === true || (typeof obj.cache === "function" && obj.cache(realData))) {
                        wx.setStorage({
                            key: obj.url,
                            data: realData
                        })
                    }
                } else {
                    // 接口返回失败码
                    fail(obj, res);
                }
            } else {
                fail(obj, res);
            }
        },
        fail: function (res) {
            fail(obj, res);
            console.error(res);
        },
        complete: function () {
            obj.count--;
            typeof obj.complete === "function" && obj.count == 0 && obj.complete();
        }
    })
}

function uploadFile(obj) {
    obj.count++;

    if (!obj.formData) {
        obj.formData = {};
    }
    obj.formData[sessionName] = session;

    // 如果有全局参数，则添加
    var gd = {};
    if (typeof globalData === "function") {
        gd = globalData();
    } else if (typeof globalData === "object") {
        gd = globalData;
    }
    obj.formData = Object.assign({}, gd, obj.formData);

    obj.dataType = obj.dataType || 'json';

    // 如果请求的URL中不是http开头的，则自动添加配置中的前缀
    var url = obj.url.startsWith('http') ? obj.url : (urlPerfix + obj.url);

    // 在URL中自动加上登录态和全局参数
    if (session) {
        if (url.indexOf('?') >= 0) {
            url += '&' + sessionName + '=' + session;
        } else {
            url += '?' + sessionName + '=' + session;
        }
    }

    // 如果有全局参数，则在URL中添加
    for (var i in gd) {
        if (url.indexOf('?') >= 0) {
            url += '&' + i + '=' + gd[i];
        } else {
            url += '?' + i + '=' + gd[i];
        }
    }

    // 如果有上报字段配置，则记录请求发出前的时间戳
    if (obj.report) {
        obj._reportStartTime = new Date().getTime();
    }

    wx.uploadFile({
        url: url,
        filePath: obj.filePath || '',
        name: obj.name || '',
        formData: obj.formData,
        success: function (res) {
            if (res.statusCode == 200 && res.errMsg == 'uploadFile:ok') {

                // 如果有上报字段配置，则记录请求返回后的时间戳，并进行上报
                if (obj.report && typeof reportCGI === "function") {
                    obj.endTime = new Date().getTime();
                    reportCGI(obj.report, obj._reportStartTime, obj._reportEndTime, request);
                }

                if (obj.dataType == 'json') {
                    try {
                        res.data = JSON.parse(res.data);
                    } catch (e) {
                        fail(obj, res);
                        return false;
                    }
                }
                if (loginTrigger(res.data) && obj.reLoginLimit < reLoginLimit) {
                    // 登录态失效，且重试次数不超过配置
                    session = '';
                    wx.removeStorage({
                        key: sessionName,
                        complete: function () {
                            doLogin(function () {
                                uploadFileWrapper(obj);
                            }, obj)
                        }
                    })
                } else if (successTrigger(res.data) && typeof obj.success === "function") {
                    // 接口返回成功码
                    obj.success(successData(res.data));
                } else {
                    // 接口返回失败码
                    fail(obj, res);
                }
            } else {
                fail(obj, res);
            }
        },
        fail: function (res) {
            fail(obj, res);
            console.error(res);
        },
        complete: function () {
            obj.count--;
            typeof obj.complete === "function" && obj.count == 0 && obj.complete();
        }
    })
}

function fail(obj, res) {
    if (typeof obj.fail === "function") {
        obj.fail(res);
    } else {
        var title = "";
        if (typeof errorTitle === "function") {
            try {
                title = errorTitle(res.data)
            } catch (e) {
            }
        } else if (typeof errorTitle === "string") {
            title = errorTitle;
        }

        var content = "";
        if (typeof errorContent === "function") {
            try {
                content = errorContent(res.data)
            } catch (e) {
            }
        } else if (typeof errorContent === "string") {
            content = errorContent;
        }

        wx.showModal({
            title: title,
            content: content || "网络或服务异常，请稍后重试",
            showCancel: false
        })
    }

    // 如果有配置统一错误回调函数，则执行它
    if (typeof errorCallback === "function") {
        errorCallback(obj, res);
    }

    console.error(res);
}

function getCache(obj, callback) {
    if (obj.cache) {
        wx.getStorage({
            key: obj.url,
            success: function (res) {
                if (typeof obj.cache === "function" && obj.cache(res.data)) {
                    typeof obj.success === "function" && obj.success(res.data);
                } else if (obj.cache == true) {
                    typeof obj.success === "function" && obj.success(res.data);
                }
            },
            fail: function () {
                callback();
            }
        })
    } else {
        callback();
    }
}

function login(callback) {
    checkSession(callback, {})
}

function init(params) {
    sessionName    = params.sessionName || 'session';
    loginTrigger   = params.loginTrigger || function () {
            return false
        };
    codeToSession  = params.codeToSession || {};
    successTrigger = params.successTrigger || function () {
            return true
        };
    urlPerfix      = params.urlPerfix || "";
    successData    = params.successData || function (res) {
            return res
        };
    errorTitle     = params.errorTitle || "操作失败";
    errorContent   = params.errorContent || false;
    reLoginLimit   = params.reLoginLimit || 3;
    errorCallback  = params.errorCallback || null;
    sessionIsFresh = params.doNotCheckSession || false;
    reportCGI      = params.reportCGI || false;
    mockJson       = params.mockJson || false;
    globalData     = params.globalData || false;

    try {
        session = wx.getStorageSync(sessionName) || '';
    } catch (e) {
    }
}

function requestWrapper(obj) {
    obj = preDo(obj);
    if (mockJson && mockJson[obj.url]) {
        // mock 模式
        mock(obj);
    } else {
        getCache(obj, function () {
                checkSession(function () {
                    request(obj);
                }, obj)
            }
        )
    }
}

function uploadFileWrapper(obj) {
    obj = preDo(obj);
    checkSession(function () {
        uploadFile(obj);
    }, obj)
}

function setSession(s) {
    session        = s;
    sessionIsFresh = true;
}

function mock(obj) {
    var res = {
        data: mockJson[obj.url]
    };
    if (successTrigger(res.data) && typeof obj.success === "function") {
        // 接口返回成功码
        obj.success(successData(res.data));
    } else {
        // 接口返回失败码
        fail(obj, res);
    }
    if (typeof obj.complete === "function") {
        obj.complete();
    }
}

module.exports = {
    init: init,
    request: requestWrapper,
    uploadFile: uploadFileWrapper,
    setSession: setSession,
    login: login
};