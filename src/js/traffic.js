/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-2018 Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

'use strict';

/******************************************************************************/

// Start isolation from global scope

µBlock.webRequest = (function() {

/******************************************************************************/

var AcceptHeaders = {
    chrome: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    firefox: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};
var CommonUserAgent = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36';

var exports = {};

/********************************* ADN ****************************************/

// Called before each outgoing request (ADN:)
var onBeforeSendHeaders = function (details) {

  var headers = details.requestHeaders, prefs = µBlock.userSettings, adn = µBlock.adnauseam;

  // if clicking/hiding is enabled with DNT, then send the DNT header
  var respectDNT = ((prefs.clickingAds && prefs.disableClickingForDNT) ||
    (prefs.hidingAds && prefs.disableHidingForDNT));

  if (respectDNT) {

    var pageStore = µBlock.mustPageStoreFromTabId(details.tabId);

    // add it only if the browser is not sending it already
    if (pageStore.getNetFilteringSwitch() && !hasDNT(headers)) {

      if (details.type === 'main_frame') // minimize logging
        adn.logNetEvent('[HEADER]', 'Append', 'DNT:1', details.url);

      addHeader(headers, 'DNT', '1');
    }
  }

  // Is this an XMLHttpRequest ?
  if (vAPI.isBehindTheSceneTabId(details.tabId)) {

    // If so, is it one of our Ad visits ?
    var ad = adn.lookupAd(details.url, details.requestId);

    // if so, handle the headers (cookies, ua, referer, dnt)
    ad && beforeAdVisit(details, headers, prefs, ad, respectDNT);

    //if (ad) console.log('ADN=VISIT: '+details.url, 'DNT? '+hasDNT(headers), ad);
  }

  // ADN: if this was an adn-allowed request, do we block cookies, etc.? TODO
  return { requestHeaders: headers };
};

// ADN: remove outgoing cookies, reset user-agent, strip referer
var beforeAdVisit = function (details, headers, prefs, ad, respectDNT) {

  var referer = ad.pageUrl, refererIdx = -1, uirIdx = -1, dbug = 0;

  ad.requestId = details.requestId; // needed?

  dbug && console.log('[HEADERS] (Outgoing'+(ad.targetUrl===details.url ? ')' : '-redirect)'), details.url);

  for (var i = headers.length - 1; i >= 0; i--) {

    dbug && console.log(i + ") " + headers[i].name, headers[i].value);
    var name = headers[i].name.toLowerCase();

    if ((name === 'http_x_requested_with') ||
      (name === 'x-devtools-emulate-network-conditions-client-id') ||
      (prefs.noOutgoingCookies && name === 'cookie') ||
      (prefs.noOutgoingUserAgent && name === 'user-agent'))
    {
      setHeader(headers[i], '');

      // Block outgoing cookies and user-agent here if specified
      if (prefs.noOutgoingCookies && name === 'cookie') {

        µBlock.adnauseam.logNetEvent('[COOKIE]', 'Strip', headers[i].value, details.url);
      }

      // Replace user-agent with most common string, if specified
      if (prefs.noOutgoingUserAgent && name === 'user-agent') {

         headers[i].value = CommonUserAgent;
         µBlock.adnauseam.logNetEvent('[UAGENT]', 'Default', headers[i].value, details.url);
      }
    }

    if (name === 'referer') refererIdx = i;

    if (vAPI.chrome && name === 'upgrade-insecure-requests') uirIdx = i;

    if (name === 'accept') { // Set browser-specific accept header
      setHeader(headers[i], vAPI.firefox ? AcceptHeaders.firefox : AcceptHeaders.chrome);
    }
  }

  // Add UIR header if chrome
  if (vAPI.chrome && uirIdx < 0) {
    addHeader(headers, 'Upgrade-Insecure-Requests', '1');
  }

  // add DNT header if needed and not included
  if (respectDNT && !hasDNT(headers)) {
    addHeader(headers, 'DNT', '1');
  }

  handleRefererForVisit(prefs, refererIdx, referer, details.url, headers);
};

var handleRefererForVisit = function (prefs, refIdx, referer, url, headers) {

  // console.log('handleRefererForVisit()', arguments);

  // Referer cases (4):
  // noOutgoingReferer=true  / no refIdx:     no-op
  // noOutgoingReferer=true  / have refIdx:   setHeader('')
  // noOutgoingReferer=false / no refIdx:     addHeader(referer)
  // noOutgoingReferer=false / have refIdx:   no-op
  if (refIdx > -1 && prefs.noOutgoingReferer) {

    // will never happen when using XMLHttpRequest
    µBlock.adnauseam.logNetEvent('[REFERER]', 'Strip', referer, url);
    setHeader(headers[refIdx], '');

  } else if (!prefs.noOutgoingReferer && refIdx < 0) {

    µBlock.adnauseam.logNetEvent('[REFERER]', 'Allow', referer, url);
    addHeader(headers, 'Referer', referer);
  }
};

function dumpHeaders(headers) {

  var s = '\n\n';
  for (var i = headers.length - 1; i >= 0; i--) {
    s += headers[i].name + ': ' + headers[i].value + '\n';
  }
  return s;
}

var setHeader = function (header, value) {

  if (header) header.value = value;
};

var addHeader = function (headers, name, value) {
  headers.push({
    name: name,
    value: value
  });
};

var hasDNT = function (headers) {

  for (var i = headers.length - 1; i >= 0; i--) {
    if (headers[i].name === 'DNT' && headers[i].value === '1') {
      return true;
    }
  }
  return false;
}

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/2067
//   Experimental: Block everything until uBO is fully ready.
// TODO: re-work vAPI code to match more closely how listeners are
//       registered with the webRequest API. This will simplify implementing
//       the feature here: we could have a temporary onBeforeRequest listener
//       which blocks everything until all is ready.
//       This would allow to avoid the permanent special test at the top of
//       the main onBeforeRequest just to implement this.
// https://github.com/gorhill/uBlock/issues/3130
//   Don't block root frame.

var onBeforeReady = null;

µBlock.onStartCompletedQueue.push(function(callback) {
    vAPI.onLoadAllCompleted();
    callback();
});

if ( µBlock.hiddenSettings.suspendTabsUntilReady ) {
    onBeforeReady = (function() {
        var suspendedTabs = new Set();
        µBlock.onStartCompletedQueue.push(function(callback) {
            onBeforeReady = null;
            for ( var tabId of suspendedTabs ) {
                vAPI.tabs.reload(tabId);
            }
            callback();
        });
        return function(details) {
            if (
                details.type !== 'main_frame' &&
                vAPI.isBehindTheSceneTabId(details.tabId) === false
            ) {
                suspendedTabs.add(details.tabId);
                return true;
            }
        };
    })();
}

/******************************************************************************/

// Intercept and filter web requests.

var onBeforeRequest = function(details) {
    if ( onBeforeReady !== null && onBeforeReady(details) ) {
        return { cancel: true };
    }

    // Special handling for root document.
    // https://github.com/chrisaljoudi/uBlock/issues/1001
    // This must be executed regardless of whether the request is
    // behind-the-scene
    var requestType = details.type;
    if ( requestType === 'main_frame' ) {
        return onBeforeRootFrameRequest(details);
    }

    // ADN: return here (AFTER onPageLoad) if prefs say not to block
    if (µBlock.userSettings.blockingMalware === false) return;

    // Special treatment: behind-the-scene requests
    var tabId = details.tabId;
    if ( vAPI.isBehindTheSceneTabId(tabId) ) {
        return onBeforeBehindTheSceneRequest(details);
    }

    // Lookup the page store associated with this tab id.
    var µb = µBlock,
        pageStore = µb.pageStoreFromTabId(tabId);
    if ( !pageStore ) {
        var tabContext = µb.tabContextManager.mustLookup(tabId);
        if ( vAPI.isBehindTheSceneTabId(tabContext.tabId) ) {
            return onBeforeBehindTheSceneRequest(details);
        }
        vAPI.tabs.onNavigation({ tabId: tabId, frameId: 0, url: tabContext.rawURL });
        pageStore = µb.pageStoreFromTabId(tabId);
    }

    // https://github.com/chrisaljoudi/uBlock/issues/886
    // For requests of type `sub_frame`, the parent frame id must be used
    // to lookup the proper context:
    // > If the document of a (sub-)frame is loaded (type is main_frame or
    // > sub_frame), frameId indicates the ID of this frame, not the ID of
    // > the outer frame.
    // > (ref: https://developer.chrome.com/extensions/webRequest)
    var isFrame = requestType === 'sub_frame';

    // https://github.com/chrisaljoudi/uBlock/issues/114
    var requestContext = pageStore.createContextFromFrameId(
        isFrame ? details.parentFrameId : details.frameId
    );

    // Setup context and evaluate
    var requestURL = details.url;
    requestContext.requestURL = requestURL;
    requestContext.requestHostname = µb.URI.hostnameFromURI(requestURL);
    requestContext.requestType = requestType;

    var result = pageStore.filterRequest(requestContext);

    pageStore.journalAddRequest(requestContext.requestHostname, result);

    if ( µb.logger.isEnabled() ) {
        µb.logger.writeOne(
            tabId,
            'net',
            pageStore.logData,
            requestType,
            requestURL,
            requestContext.rootHostname,
            requestContext.pageHostname
        );
    }

    // Not blocked
    if ( result !== 1 ) {
        // https://github.com/chrisaljoudi/uBlock/issues/114
        if ( details.parentFrameId !== -1 && isFrame ) {
            pageStore.setFrame(details.frameId, requestURL);
        }
        requestContext.dispose();
        return;
    }

    // Blocked

    // https://github.com/gorhill/uBlock/issues/949
    // Redirect blocked request?
    if ( µb.hiddenSettings.ignoreRedirectFilters !== true ) {
        var url = µb.redirectEngine.toURL(requestContext);
        if ( url !== undefined ) {
            // µb.adnauseam.logRedirect(requestURL, url); // ADN, log redirects (not needed)
            pageStore.internalRedirectionCount += 1;
            if ( µb.logger.isEnabled() ) {
                µb.logger.writeOne(
                    tabId,
                    'redirect',
                    { source: 'redirect', raw: µb.redirectEngine.resourceNameRegister },
                    requestType,
                    requestURL,
                    requestContext.rootHostname,
                    requestContext.pageHostname
                );
            }
            requestContext.dispose();
            return { redirectUrl: url };
        }
    }

    requestContext.dispose();
    return { cancel: true };
};

/******************************************************************************/

var onBeforeRootFrameRequest = function(details) {
    var tabId = details.tabId,
        requestURL = details.url,
        µb = µBlock;

    µb.tabContextManager.push(tabId, requestURL);

    // Special handling for root document.
    // https://github.com/chrisaljoudi/uBlock/issues/1001
    // This must be executed regardless of whether the request is
    // behind-the-scene
    var µburi = µb.URI,
        requestHostname = µburi.hostnameFromURI(requestURL),
        requestDomain = µburi.domainFromHostname(requestHostname) || requestHostname;
    var context = {
        rootHostname: requestHostname,
        rootDomain: requestDomain,
        pageHostname: requestHostname,
        pageDomain: requestDomain,
        requestURL: requestURL,
        requestHostname: requestHostname,
        requestType: 'main_frame'
    };
    var result = 0,
        logData,
        logEnabled = µb.logger.isEnabled();

    // If the site is whitelisted, disregard strict blocking
    if ( µb.getNetFilteringSwitch(requestURL) === false ) {
        result = 2;
        if ( logEnabled === true ) {
            logData = { engine: 'u', result: 2, raw: 'whitelisted' };
        }
    }

    // Permanently unrestricted?
    if ( result === 0 && µb.hnSwitches.evaluateZ('no-strict-blocking', requestHostname) ) {
        result = 2;
        if ( logEnabled === true ) {
            logData = { engine: 'u', result: 2, raw: 'no-strict-blocking: ' + µb.hnSwitches.z + ' true' };
        }
    }

    // Temporarily whitelisted?
    if ( result === 0 ) {
        result = isTemporarilyWhitelisted(result, requestHostname);
        if ( result === 2 && logEnabled === true ) {
            logData = { engine: 'u', result: 2, raw: 'no-strict-blocking true (temporary)' };
        }
    }

    // Static filtering: We always need the long-form result here.
    var snfe = µb.staticNetFilteringEngine;

    // Check for specific block
    if ( result === 0 ) {
        result = snfe.matchStringExactType(context, requestURL, 'main_frame');
        if ( result !== 0 || logEnabled === true ) {
            logData = snfe.toLogData();
        }
    }

    // Check for generic block
    if ( result === 0 ) {
        result = snfe.matchStringExactType(context, requestURL, 'no_type');
        if ( result !== 0 || logEnabled === true ) {
            logData = snfe.toLogData();
        }
        // https://github.com/chrisaljoudi/uBlock/issues/1128
        // Do not block if the match begins after the hostname, except when
        // the filter is specifically of type `other`.
        // https://github.com/gorhill/uBlock/issues/490
        // Removing this for the time being, will need a new, dedicated type.
        if (
            result === 1 &&
            toBlockDocResult(requestURL, requestHostname, logData) === false
        ) {
            result = 0;
            logData = undefined;
        }
    }

    // ADN: Tell the core we have a new page
    µb.adnauseam.onPageLoad(tabId, requestURL);

    // ADN: return here if prefs say not to block
    if (µb.userSettings.blockingMalware === false) return;

    // Log
    var pageStore = µb.bindTabToPageStats(tabId, 'beforeRequest');
    if ( pageStore ) {
        pageStore.journalAddRootFrame('uncommitted', requestURL);
        pageStore.journalAddRequest(requestHostname, result);
    }

    if ( logEnabled ) {
        µb.logger.writeOne(
            tabId,
            'net',
            logData,
            'main_frame',
            requestURL,
            requestHostname,
            requestHostname
        );
    }

    // Not blocked
    if ( result !== 1 ) { return; }

    // No log data means no strict blocking (because we need to report why
    // the blocking occurs.
    if ( logData === undefined  ) { return; }

    // Blocked

    // ADN: return here if the tab is opened from Vault
    vAPI.tabs.get(tabId, function(tab) {
         vAPI.tabs.get(tab.openerTabId, function(parentTab) {
            if (parentTab.title === "AdNauseam — AdVault") return;

            var query = btoa(JSON.stringify({
              url: requestURL,
              hn: requestHostname,
              dn: requestDomain,
              fc: logData.compiled,
              fs: logData.raw
            }));

            vAPI.tabs.replace(tabId, vAPI.getURL('document-blocked.html?details=') + query);

            return { cancel: true };

         })
    })

};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3208
//   Mind case insensitivity.

var toBlockDocResult = function(url, hostname, logData) {
    if ( typeof logData.regex !== 'string' ) { return false; }
    var re = new RegExp(logData.regex, 'i'),
        match = re.exec(url.toLowerCase());
    if ( match === null ) { return false; }

    // https://github.com/chrisaljoudi/uBlock/issues/1128
    // https://github.com/chrisaljoudi/uBlock/issues/1212
    // Relax the rule: verify that the match is completely before the path part
    return (match.index + match[0].length) <=
           (url.indexOf(hostname) + hostname.length + 1);
};

/******************************************************************************/

// Intercept and filter behind-the-scene requests.

// https://github.com/gorhill/uBlock/issues/870
// Finally, Chromium 49+ gained the ability to report network request of type
// `beacon`, so now we can block them according to the state of the
// "Disable hyperlink auditing/beacon" setting.

var onBeforeBehindTheSceneRequest = function(details) {

    if (µBlock.userSettings.blockingMalware === false) return; // ADN

    var µb = µBlock,
        pageStore = µb.pageStoreFromTabId(details.tabId);
    if ( pageStore === null ) { return; }

    var µburi = µb.URI,
        context = pageStore.createContextFromPage(),
        requestType = details.type,
        requestURL = details.url;

    context.requestURL = requestURL;
    context.requestHostname = µburi.hostnameFromURI(requestURL);
    context.requestType = requestType;

    var normalURL;
    if ( details.tabId === vAPI.anyTabId && context.pageHostname === '' ) {
        normalURL = µb.normalizePageURL(0, details.documentUrl);
        context.pageHostname = µburi.hostnameFromURI(normalURL);
        context.pageDomain = µburi.domainFromHostname(context.pageHostname);
        context.rootHostname = context.pageHostname;
        context.rootDomain = context.pageDomain;
    }

    pageStore.logData = undefined;

    // https://bugs.chromium.org/p/chromium/issues/detail?id=637577#c15
    //   Do not filter behind-the-scene network request of type `beacon`: there
    //   is no point. In any case, this will become a non-issue once
    //   <https://bugs.chromium.org/p/chromium/issues/detail?id=522129> is
    //   fixed.

    // Blocking behind-the-scene requests can break a lot of stuff: prevent
    // browser updates, prevent extension updates, prevent extensions from
    // working properly, etc.
    // So we filter if and only if the "advanced user" mode is selected.
    // https://github.com/gorhill/uBlock/issues/3150
    //   Ability to globally block CSP reports MUST also apply to
    //   behind-the-scene network requests.

    // 2018-03-30:
    //   Filter all behind-the-scene network requests like any other network
    //   requests. Hopefully this will not break stuff as it used to be the
    //   case.

    var result = 0;

    if (
        µburi.isNetworkURI(details.documentUrl) ||
        µb.userSettings.advancedUserEnabled ||
        requestType === 'csp_report'
    ) {
        result = pageStore.filterRequest(context);

        // The "any-tab" scope is not whitelist-able, and in such case we must
        // use the origin URL as the scope. Most such requests aren't going to
        // be blocked, so we further test for whitelisting and modify the
        // result only when the request is being blocked.
        if (
            result === 1 &&
            normalURL !== undefined &&
            µb.getNetFilteringSwitch(normalURL) === false
        ) {
            result = 2;
            pageStore.logData = { engine: 'u', result: 2, raw: 'whitelisted' };
        }
    }

    pageStore.journalAddRequest(context.requestHostname, result);

    if ( µb.logger.isEnabled() ) {
        µb.logger.writeOne(
            details.tabId,
            'net',
            pageStore.logData,
            requestType,
            requestURL,
            context.rootHostname,
            context.rootHostname
        );
    }

    context.dispose();

    // Blocked?
    if ( result === 1 ) {
        // ADN: Blocked xhr
        µb.adnauseam.logNetBlock(details.type, requestURL, JSON.stringify(context));
        return { 'cancel': true };
    }

};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3140

var onBeforeMaybeSpuriousCSPReport = function(details) {
    var tabId = details.tabId;

    // Ignore behind-the-scene requests.
    if ( vAPI.isBehindTheSceneTabId(tabId) ) { return; }

    // Lookup the page store associated with this tab id.
    var µb = µBlock,
        pageStore = µb.pageStoreFromTabId(tabId);
    if ( pageStore === null ) { return; }

    // If uBO is disabled for the page, it can't possibly causes CSP reports
    // to be triggered.
    if ( pageStore.getNetFilteringSwitch() === false ) { return; }

    // A resource was redirected to a neutered one?
    // TODO: mind injected scripts/styles as well.
    if ( pageStore.internalRedirectionCount === 0 ) { return; }

    var textDecoder = onBeforeMaybeSpuriousCSPReport.textDecoder;
    if (
        textDecoder === undefined &&
        typeof self.TextDecoder === 'function'
    ) {
        textDecoder =
        onBeforeMaybeSpuriousCSPReport.textDecoder = new TextDecoder();
    }

    // Find out whether the CSP report is a potentially spurious CSP report.
    // If from this point on we are unable to parse the CSP report data, the
    // safest assumption to protect users is to assume the CSP report is
    // spurious.
    if (
        textDecoder !== undefined &&
        details.method === 'POST'
    ) {
        var raw = details.requestBody && details.requestBody.raw;
        if (
            Array.isArray(raw) &&
            raw.length !== 0 &&
            raw[0] instanceof Object &&
            raw[0].bytes instanceof ArrayBuffer
        ) {
            var data;
            try {
                data = JSON.parse(textDecoder.decode(raw[0].bytes));
            } catch (ex) {
            }
            if ( data instanceof Object ) {
                var report = data['csp-report'];
                if ( report instanceof Object ) {
                    var blocked = report['blocked-uri'] || report['blockedURI'],
                        validBlocked = typeof blocked === 'string',
                        source = report['source-file'] || report['sourceFile'],
                        validSource = typeof source === 'string';
                    if (
                        (validBlocked || validSource) &&
                        (!validBlocked || !blocked.startsWith('data')) &&
                        (!validSource || !source.startsWith('data'))
                    ) {
                        return;
                    }
                }
            }
        }
    }

    // Potentially spurious CSP report.
    if ( µb.logger.isEnabled() ) {
        var hostname = µb.URI.hostnameFromURI(details.url);
        µb.logger.writeOne(
            tabId,
            'net',
            { result: 1, source: 'global', raw: 'no-spurious-csp-report' },
            'csp_report',
            details.url,
            hostname,
            hostname
        );
    }

    return { cancel: true };
};

onBeforeMaybeSpuriousCSPReport.textDecoder = undefined;

/******************************************************************************/

// To handle:
// - Media elements larger than n kB
// - Scriptlet injection (requires ability to modify response body)
// - HTML filtering (requires ability to modify response body)
// - CSP injection

var onHeadersReceived = function(details) {
    // Do not interfere with behind-the-scene requests.
    var ad, result, dbug = 0; //ADN

    var tabId = details.tabId,
        µb = µBlock,
        requestType = details.type,
        isRootDoc = requestType === 'main_frame',
        isDoc = isRootDoc || requestType === 'sub_frame';

     //ADN
    if (vAPI.isBehindTheSceneTabId(tabId)) {

      // ADN: handle incoming cookies for our visits (ignore in ff for now)
      if (vAPI.chrome && µb.userSettings.noIncomingCookies) {

          dbug && console.log('onHeadersReceived: ', requestType, details.url);

          // ADN
          ad = µb.adnauseam.lookupAd(details.url, details.requestId);
          if (ad) {

            // this is an ADN request
            µb.adnauseam.blockIncomingCookies(details.responseHeaders, details.url, ad.targetUrl);
          }
          else if (dbug && vAPI.chrome) {

            console.log('Ignoring non-ADN response', requestType, details.url);
          }
      }

      // don't return an empty headers array
      return details.responseHeaders.length ?
        { 'responseHeaders': details.responseHeaders } : null;
    }


    if ( isRootDoc ) {
        µb.tabContextManager.push(tabId, details.url);
    }

    var pageStore = µb.pageStoreFromTabId(tabId);

    // ADN: check if this was an allowed exception and, if so, block cookies
    var  modified = pageStore && µBlock.adnauseam.checkAllowedException
        (details.responseHeaders, details.url, pageStore.rawURL);

    if ( pageStore === null ) {
        if ( isRootDoc === false ) { return; }
        pageStore = µb.bindTabToPageStats(tabId, 'beforeRequest');
    }
    if ( pageStore.getNetFilteringSwitch() === false ) { return; }

    if ( requestType === 'image' || requestType === 'media' ) {
        result = foilLargeMediaElement(pageStore, details);
        return result
    }

    if ( isDoc && µb.canFilterResponseBody ) {
        filterDocument(pageStore, details);
    }

    // https://github.com/gorhill/uBlock/issues/2813
    //   Disable the blocking of large media elements if the document is itself
    //   a media element: the resource was not prevented from loading so no
    //   point to further block large media elements for the current document.
    if ( isRootDoc ) {
        if ( reMediaContentTypes.test(headerValueFromName('content-type', details.responseHeaders)) ) {
            pageStore.allowLargeMediaElementsUntil = Date.now() + 86400000;
        }
        return injectCSP(pageStore, details);
    }

    if ( isDoc ) {
        return injectCSP(pageStore, details);
    }
    // ADN
    if (!result) {

      // ADN: if this was an allowed exception block cookies
      var pageStore = µBlock.pageStoreFromTabId(details.tabId),
          modified = pageStore && µBlock.adnauseam.checkAllowedException
              (details.responseHeaders, details.url, pageStore.rawURL);

      if (modified && details.responseHeaders.length) {
          result = { 'responseHeaders': details.responseHeaders };
      }
    }
};

var reMediaContentTypes = /^(?:audio|image|video)\//;

/*******************************************************************************

    The response body filterer is responsible for:

    - Scriptlet filtering
    - HTML filtering

    In the spirit of efficiency, the response body filterer works this way:

    If:
        - HTML filtering: no.
        - Scriptlet filtering: no.
    Then:
        No response body filtering is initiated.

    If:
        - HTML filtering: no.
        - Scriptlet filtering: yes.
    Then:
        Inject scriptlets before first chunk of response body data reported
        then immediately disconnect response body data listener.

    If:
        - HTML filtering: yes.
        - Scriptlet filtering: no/yes.
    Then:
        Assemble all response body data into a single buffer. Once all the
        response data has been received, create a document from it. Then:
        - Inject scriptlets in the resulting DOM.
        - Remove all DOM elements matching HTML filters.
        Then serialize the resulting modified document as the new response
        body.

    This way, the overhead is minimal for when only scriptlets need to be
    injected.

    If the platform does not support response body filtering, the scriptlets
    will be injected the old way, through the content script.

**/

var filterDocument = (function() {
    var µb = µBlock,
        filterers = new Map(),
        domParser, xmlSerializer,
        utf8TextDecoder, textDecoder, textEncoder;

    var textDecode = function(encoding, buffer) {
        if (
            textDecoder !== undefined &&
            textDecoder.encoding !== encoding
        ) {
            textDecoder = undefined;
        }
        if ( textDecoder === undefined ) {
            textDecoder = new TextDecoder(encoding);
        }
        return textDecoder.decode(buffer);
    };

    var reContentTypeDocument = /^(?:text\/html|application\/xhtml\+xml)/i,
        reContentTypeCharset = /charset=['"]?([^'" ]+)/i;

    var mimeFromContentType = function(contentType) {
        var match = reContentTypeDocument.exec(contentType);
        if ( match !== null ) {
            return match[0].toLowerCase();
        }
    };

    var charsetFromContentType = function(contentType) {
        var match = reContentTypeCharset.exec(contentType);
        if ( match !== null ) {
            return match[1].toLowerCase();
        }
    };

    var charsetFromDoc = function(doc) {
        var meta = doc.querySelector('meta[charset]');
        if ( meta !== null ) {
            return meta.getAttribute('charset').toLowerCase();
        }
        meta = doc.querySelector(
            'meta[http-equiv="content-type" i][content]'
        );
        if ( meta !== null ) {
            return charsetFromContentType(meta.getAttribute('content'));
        }
    };

    // Purpose of following helper is to disconnect from watching the stream
    // if all the following conditions are fulfilled:
    // - Only need to inject scriptlets.
    // - Charset of resource is utf-8.
    // - A well-formed doc type declaration is found at the top.
    //
    // When all the conditions are fulfilled, then the scriptlets are safely
    // injected after the doc type declaration, and the stream listener is
    // disconnected, thus removing overhead from future streaming data.
    //
    // If at least one of the condition is not fulfilled and scriptlets need
    // to be injected, it will be done the longer way when the whole stream
    // has been collated in memory.

    var streamJobDone = function(filterer, responseBytes) {
        if (
            filterer.scriptlets === undefined ||
            filterer.selectors !== undefined ||
            filterer.charset === undefined
        ) {
            return false;
        }
        // We need to insert after DOCTYPE, or else the browser may fall into
        // quirks mode.
        if ( responseBytes.byteLength < 256 ) { return false; }
        var bb = new Uint8Array(responseBytes, 0, 256),
            i = 0, b;
        // Skip BOM if present.
        if ( bb[0] === 0xEF && bb[1] === 0xBB && bb[2] === 0xBF ) { i += 3; }
        // Scan for '<'
        for (;;) {
            b = bb[i++];
            if ( b === 0x3C /* '<' */ ) { break; }
            if ( b > 0x20 || i > 240 ) { return false; }
        }
        // Case insensitively test for '!doctype'.
        if (
              bb[i+0]          === 0x21 /* '!' */ &&
            ( bb[i+1] | 0x20 ) === 0x64 /* 'd' */ &&
            ( bb[i+2] | 0x20 ) === 0x6F /* 'o' */ &&
            ( bb[i+3] | 0x20 ) === 0x63 /* 'c' */ &&
            ( bb[i+4] | 0x20 ) === 0x74 /* 't' */ &&
            ( bb[i+5] | 0x20 ) === 0x79 /* 'y' */ &&
            ( bb[i+6] | 0x20 ) === 0x70 /* 'p' */ &&
            ( bb[i+7] | 0x20 ) === 0x65 /* 'e' */
        ) {
            i += 8;
        }
        // Case insensitively test for 'html'.
        else if (
            ( bb[i+0] | 0x20 ) === 0x68 /* 'h' */ &&
            ( bb[i+1] | 0x20 ) === 0x74 /* 't' */ &&
            ( bb[i+2] | 0x20 ) === 0x6D /* 'm' */ &&
            ( bb[i+3] | 0x20 ) === 0x6C /* 'l' */
        ) {
            i += 4;
        } else {
            return false;
        }
        // Scan for '>'.
        var qcount = 0;
        for (;;) {
            b = bb[i++];
            if ( b === 0x3E /* '>' */ ) { break; }
            if ( b === 0x22 /* '"' */ || b === 0x27 /* "'" */ ) { qcount += 1; }
            if ( b > 0x7F || i > 240 ) { return false; }
        }
        // Bail out if mismatched quotes.
        if ( (qcount & 1) !== 0 ) { return false; }
        // We found a valid insertion point.
        if ( textEncoder === undefined ) { textEncoder = new TextEncoder(); }
        filterer.stream.write(new Uint8Array(responseBytes, 0, i));
        filterer.stream.write(
            textEncoder.encode('<script>' + filterer.scriptlets + '</script>')
        );
        filterer.stream.write(new Uint8Array(responseBytes, i));
        return true;
    };

    var streamClose = function(filterer, buffer) {
        if ( buffer !== undefined ) {
            filterer.stream.write(buffer);
        } else if ( filterer.buffer !== undefined ) {
            filterer.stream.write(filterer.buffer);
        }
        filterer.stream.close();
    };

    var onStreamData = function(ev) {
        var filterer = filterers.get(this);
        if ( filterer === undefined ) {
            this.write(ev.data);
            this.disconnect();
            return;
        }
        if (
            this.status !== 'transferringdata' &&
            this.status !== 'finishedtransferringdata'
        ) {
            filterers.delete(this);
            this.disconnect();
            return;
        }
        // TODO:
        // - Possibly improve buffer growth, if benchmarking shows it's worth
        //   it.
        // - Also evaluate whether keeping a list of buffers and then decoding
        //   them in sequence using TextDecoder's "stream" option is more
        //   efficient. Can the data buffers be safely kept around for later
        //   use?
        // - Informal, quick benchmarks seem to show most of the overhead is
        //   from calling TextDecoder.decode() and TextEncoder.encode(), and if
        //   confirmed, there is nothing which can be done uBO-side to reduce
        //   overhead.
        if ( filterer.buffer === null ) {
            if ( streamJobDone(filterer, ev.data) ) {
                filterers.delete(this);
                this.disconnect();
                return;
            }
            filterer.buffer = new Uint8Array(ev.data);
            return;
        }
        var buffer = new Uint8Array(
            filterer.buffer.byteLength +
            ev.data.byteLength
        );
        buffer.set(filterer.buffer);
        buffer.set(new Uint8Array(ev.data), filterer.buffer.byteLength);
        filterer.buffer = buffer;
    };

    var onStreamStop = function() {
        var filterer = filterers.get(this);
        filterers.delete(this);
        if ( filterer === undefined || filterer.buffer === null ) {
            this.close();
            return;
        }
        if ( this.status !== 'finishedtransferringdata' ) { return; }

        if ( domParser === undefined ) {
            domParser = new DOMParser();
            xmlSerializer = new XMLSerializer();
        }
        if ( textEncoder === undefined ) {
            textEncoder = new TextEncoder();
        }

        var doc;

        // If stream encoding is still unknnown, try to extract from document.
        var charsetFound = filterer.charset,
            charsetUsed = charsetFound;
        if ( charsetFound === undefined ) {
            if ( utf8TextDecoder === undefined ) {
                utf8TextDecoder = new TextDecoder();
            }
            doc = domParser.parseFromString(
            );
            charsetFound = charsetFromDoc(doc);
            charsetUsed = µb.textEncode.normalizeCharset(charsetFound);
            if ( charsetUsed === undefined ) {
                return streamClose(filterer);
            }
        }

        doc = domParser.parseFromString(
            textDecode(charsetUsed, filterer.buffer),
            filterer.mime
        );

        // https://github.com/gorhill/uBlock/issues/3507
        //   In case of no explicit charset found, try to find one again, but
        //   this time with the whole document parsed.
        if ( charsetFound === undefined ) {
            charsetFound = µb.textEncode.normalizeCharset(charsetFromDoc(doc));
            if ( charsetFound !== charsetUsed ) {
                if ( charsetFound === undefined ) {
                    return streamClose(filterer);
                }
                charsetUsed = charsetFound;
                doc = domParser.parseFromString(
                    textDecode(charsetFound, filterer.buffer),
                    filterer.mime
                );
            }
        }

        var modified = false;
        if ( filterer.selectors !== undefined ) {
            if ( µb.htmlFilteringEngine.apply(doc, filterer) ) {
                modified = true;
            }
        }
        if ( filterer.scriptlets !== undefined ) {
            if ( µb.scriptletFilteringEngine.apply(doc, filterer) ) {
                modified = true;
            }
        }

        if ( modified === false ) {
            return streamClose(filterer);
        }

        // https://stackoverflow.com/questions/6088972/get-doctype-of-an-html-as-string-with-javascript/10162353#10162353
        var doctypeStr = doc.doctype instanceof Object ?
                xmlSerializer.serializeToString(doc.doctype) + '\n' :
                '';

        // https://github.com/gorhill/uBlock/issues/3391
        var encodedStream = textEncoder.encode(
            doctypeStr +
            doc.documentElement.outerHTML
        );
        if ( charsetUsed !== 'utf-8' ) {
            encodedStream = µb.textEncode.encode(
                charsetUsed,
                encodedStream
            );
        }

        streamClose(filterer, encodedStream);
    };

    var onStreamError = function() {
        filterers.delete(this);
    };

    return function(pageStore, details) {
        // https://github.com/gorhill/uBlock/issues/3478
        var statusCode = details.statusCode || 0;
        if ( statusCode !== 0 && (statusCode < 200 || statusCode >= 300) ) {
            return;
        }

        var hostname = µb.URI.hostnameFromURI(details.url);
        if ( hostname === '' ) { return; }

        var domain = µb.URI.domainFromHostname(hostname);

        var request = {
            stream: undefined,
            tabId: details.tabId,
            url: details.url,
            hostname: hostname,
            domain: domain,
            entity: µb.URI.entityFromDomain(domain),
            selectors: undefined,
            scriptlets: undefined,
            buffer: null,
            mime: undefined,
            charset: undefined
        };

        request.selectors = µb.htmlFilteringEngine.retrieve(request);

        // https://github.com/gorhill/uBlock/issues/3526
        // https://github.com/uBlockOrigin/uAssets/issues/1492
        //   Two distinct issues, but both are arising as a result of
        //   injecting scriptlets through stream filtering. So falling back
        //   to "slow" scriplet injection for the time being. Stream filtering
        //   (`##^`) should be used for when scriptlets are defeated by early
        //   script tags on a page.
        //

        if (
            request.selectors === undefined &&
            request.scriptlets === undefined
        ) {
            return;
        }

        var headers = details.responseHeaders,
            contentType = headerValueFromName('content-type', headers);
        if ( contentType !== '' ) {
            request.mime = mimeFromContentType(contentType);
            if ( request.mime === undefined ) { return; }
            var charset = charsetFromContentType(contentType);
            if ( charset !== undefined ) {
                charset = µb.textEncode.normalizeCharset(charset);
                if ( charset === undefined ) { return; }
                request.charset = charset;
            }
        }
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1426789
        if ( headerValueFromName('content-disposition', headers) ) { return; }

        var stream = request.stream =
            vAPI.net.webRequest.filterResponseData(details.requestId);
        stream.ondata = onStreamData;
        stream.onstop = onStreamStop;
        stream.onerror = onStreamError;
        filterers.set(stream, request);
    };
})();

/******************************************************************************/

var injectCSP = function(pageStore, details) {
    var µb = µBlock,
        tabId = details.tabId,
        requestURL = details.url,
        loggerEnabled = µb.logger.isEnabled(),
        logger = µb.logger,
        cspSubsets = [];

    var context = pageStore.createContextFromPage();
    context.requestHostname = µb.URI.hostnameFromURI(requestURL);
    if ( details.type !== 'main_frame' ) {
        context.pageHostname = context.pageDomain = context.requestHostname;
    }
    context.requestURL = requestURL;

    // Start collecting policies >>>>>>>>

    // ======== built-in policies

    var builtinDirectives = [];

    context.requestType = 'inline-script';
    if ( pageStore.filterRequest(context) === 1 ) {
        builtinDirectives.push("script-src 'unsafe-eval' * blob: data:");
    }
    if ( loggerEnabled === true ) {
        logger.writeOne(
            tabId,
            'net',
            pageStore.logData,
            'inline-script',
            requestURL,
            context.rootHostname,
            context.pageHostname
        );
    }

    // https://github.com/gorhill/uBlock/issues/1539
    // - Use a CSP to also forbid inline fonts if remote fonts are blocked.
    context.requestType = 'inline-font';
    if ( pageStore.filterRequest(context) === 1 ) {
        builtinDirectives.push('font-src *');
        if ( loggerEnabled === true ) {
            logger.writeOne(
                tabId,
                'net',
                pageStore.logData,
                'inline-font',
                requestURL,
                context.rootHostname,
                context.pageHostname
            );
        }
    }

    if ( builtinDirectives.length !== 0 ) {
        cspSubsets[0] = builtinDirectives.join('; ');
    }

    // ======== filter-based policies

    // Static filtering.

    var logDataEntries = [];

    µb.staticNetFilteringEngine.matchAndFetchData(
        'csp',
        requestURL,
        cspSubsets,
        loggerEnabled === true ? logDataEntries : undefined
    );

    // URL filtering `allow` rules override static filtering.
    if (
        cspSubsets.length !== 0 &&
        µb.sessionURLFiltering.evaluateZ(context.rootHostname, requestURL, 'csp') === 2
    ) {
        if ( loggerEnabled === true ) {
            logger.writeOne(
                tabId,
                'net',
                µb.sessionURLFiltering.toLogData(),
                'csp',
                requestURL,
                context.rootHostname,
                context.pageHostname
            );
        }
        context.dispose();
        return;
    }

    // Dynamic filtering `allow` rules override static filtering.
    if (
        cspSubsets.length !== 0 &&
        µb.userSettings.advancedUserEnabled &&
        µb.sessionFirewall.evaluateCellZY(context.rootHostname, context.rootHostname, '*') === 2
    ) {
        if ( loggerEnabled === true ) {
            logger.writeOne(
                tabId,
                'net',
                µb.sessionFirewall.toLogData(),
                'csp',
                requestURL,
                context.rootHostname,
                context.pageHostname
            );
        }
        context.dispose();
        return;
    }

    // <<<<<<<< All policies have been collected

    // Static CSP policies will be applied.
    for ( var entry of logDataEntries ) {
        logger.writeOne(
            tabId,
            'net',
            entry,
            'csp',
            requestURL,
            context.rootHostname,
            context.pageHostname
        );
    }

    context.dispose();

    if ( cspSubsets.length === 0 ) {
        return;
    }

    µb.updateBadgeAsync(tabId);

    // Use comma to merge CSP directives.
    // Ref.: https://www.w3.org/TR/CSP2/#implementation-considerations
    //
    // https://github.com/gorhill/uMatrix/issues/967
    //   Inject a new CSP header rather than modify an existing one, except
    //   if the current environment does not support merging headers:
    //   Firefox 58/webext and less can't merge CSP headers, so we will merge
    //   them here.
    var headers = details.responseHeaders;

    if ( cantMergeCSPHeaders ) {
        var i = headerIndexFromName('content-security-policy', headers);
        if ( i !== -1 ) {
            cspSubsets.unshift(headers[i].value.trim());
            headers.splice(i, 1);
        }
    }

    headers.push({
        name: 'Content-Security-Policy',
        value: cspSubsets.join(', ')
    });

    return { 'responseHeaders': headers };
};

// https://github.com/gorhill/uMatrix/issues/967#issuecomment-373002011
//   This can be removed once Firefox 60 ESR is released.
var cantMergeCSPHeaders = (function() {
    if (
        self.browser instanceof Object &&
        typeof self.browser.runtime.getBrowserInfo === 'function'
    ) {
        self.browser.runtime.getBrowserInfo().then(function(info) {
            cantMergeCSPHeaders =
                info.vendor === 'Mozilla' &&
                info.name === 'Firefox' &&
                parseInt(info.version, 10) < 59;
        });
    }
    return false;
})();

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/1163
//   "Block elements by size"

var foilLargeMediaElement = function(pageStore, details) {
    var µb = µBlock;

    var i = headerIndexFromName('content-length', details.responseHeaders);
    if ( i === -1 ) { return; }

    var tabId = details.tabId,
        size = parseInt(details.responseHeaders[i].value, 10) || 0,
        result = pageStore.filterLargeMediaElement(size);
    if ( result === 0 ) { return; }

    if ( µb.logger.isEnabled() ) {
        µb.logger.writeOne(
            tabId,
            'net',
            pageStore.logData,
            details.type,
            details.url,
            pageStore.tabHostname,
            pageStore.tabHostname
        );
    }

    return { cancel: true };
};

/******************************************************************************/

// Caller must ensure headerName is normalized to lower case.

var headerIndexFromName = function(headerName, headers) {
    var i = headers.length;
    while ( i-- ) {
        if ( headers[i].name.toLowerCase() === headerName ) {
            return i;
        }
    }
    return -1;
};

var headerValueFromName = function(headerName, headers) {
    var i = headerIndexFromName(headerName, headers);
    return i !== -1 ? headers[i].value : '';
};

/******************************************************************************/

vAPI.net.onBeforeRequest = {
    urls: [
        'http://*/*',
        'https://*/*'
    ],
    extra: [ 'blocking' ],
    callback: onBeforeRequest
};

vAPI.net.onBeforeMaybeSpuriousCSPReport = {
    callback: onBeforeMaybeSpuriousCSPReport
};

vAPI.net.onHeadersReceived = {
    urls: [
        'http://*/*',
        'https://*/*'
    ],
    /*types: [ // ADN
        'main_frame',
        'sub_frame',
        'image',
        'media',
        'script'
    ],*/
    extra: [ 'blocking', 'responseHeaders' ],
    callback: onHeadersReceived
};

vAPI.net.onBeforeSendHeaders = {   // ADN
  urls: [
    'http://*/*',
    'https://*/*'
  ],
  extra: ['blocking', 'requestHeaders'],
  callback: onBeforeSendHeaders
};

vAPI.net.registerListeners();

/******************************************************************************/

var isTemporarilyWhitelisted = function(result, hostname) {
    var obsolete, pos;

    for (;;) {
        obsolete = documentWhitelists[hostname];
        if ( obsolete !== undefined ) {
            if ( obsolete > Date.now() ) {
                if ( result === 0 ) {
                    return 2;
                }
            } else {
                delete documentWhitelists[hostname];
            }
        }
        pos = hostname.indexOf('.');
        if ( pos === -1 ) { break; }
        hostname = hostname.slice(pos + 1);
    }
    return result;
};

var documentWhitelists = Object.create(null);

/******************************************************************************/

exports.temporarilyWhitelistDocument = function(hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) {
        return;
    }

    documentWhitelists[hostname] = Date.now() + 60 * 1000;
};

/******************************************************************************/

return exports;

/******************************************************************************/

})();

/******************************************************************************/
