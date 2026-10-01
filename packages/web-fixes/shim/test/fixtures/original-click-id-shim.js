/* <!-- OpenArt Click ID Shim --> */
  (function() {
    try {
      var params = new URLSearchParams(window.location.search);
      var openArtHostPattern = /(^|\.)openart\.ai$/i;
      var productionHostPattern = /^(www\.)?openart\.ai$/i;
      var isOpenArtHost = openArtHostPattern.test(window.location.hostname);
      var isProductionHost = productionHostPattern.test(window.location.hostname);

      function safeLocalStorageSet(key, value) {
        try {
          window.localStorage.setItem(key, value);
        } catch (_err) {}
      }

      function setOpenArtCookie(key, value, maxAgeSeconds) {
        if (!isOpenArtHost) return;
        console.log("value", value);
        console.log("encodeURIComponent(value)", encodeURIComponent(value));
        document.cookie =
          key + '=' + encodeURIComponent(value) +
          '; max-age=' + maxAgeSeconds +
          '; path=/; domain=.openart.ai; SameSite=Lax';
      }

      function postImpactClickId(clickId) {
        if (!isOpenArtHost || typeof fetch !== 'function') return;

        try {
          fetch('/legacy/api/tracking/impact/store-clickid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ clickId: clickId }),
          }).catch(function() {});
        } catch (_err) {}
      }

      function loadTolt() {
        if (document.getElementById('tolt-referral')) return;

        var existingScript = document.querySelector('script[src="https://cdn.tolt.io/tolt.js"]');
        if (existingScript) return;

        var script = document.createElement('script');
        script.id = 'tolt-referral';
        script.src = 'https://cdn.tolt.io/tolt.js';
        script.async = true;
        script.defer = true;
        script.setAttribute('data-tolt', 'ae0f5a8f-ead8-4050-a9a4-f6b44ca09e95');
        (document.head || document.documentElement).appendChild(script);
      }

      var clickIds = ['gclid', 'fbclid', 'msclkid', 'rdt_cid', 'gbraid', 'wbraid'];
      clickIds.forEach(function(key) {
        var value = params.get(key);
        if (value) {
          setOpenArtCookie(key, value, 7776000);
        }
      });

      var oaAdClidParams = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'];
      var oaAdClidPattern = /^[A-Za-z0-9._-]{1,512}$/;
      var oaIncoming = {};
      var now = Date.now();
      oaAdClidParams.forEach(function(key) {
        var val = params.get(key);
        if (val && oaAdClidPattern.test(val)) {
          oaIncoming[key] = { v: val, ts: now };
        }
      });
      if (Object.keys(oaIncoming).length > 0) {
        var oaExisting = {};
        try {
          var oaMatch = document.cookie.match(/(?:^|;\s*)oa_ad_clids=([^;]*)/);
          if (oaMatch) oaExisting = JSON.parse(decodeURIComponent(oaMatch[1])) || {};
        } catch(_e) {}
        oaAdClidParams.forEach(function(key) {
          if (oaIncoming[key]) oaExisting[key] = oaIncoming[key];
        });
        var oaJson = JSON.stringify(oaExisting);
        setOpenArtCookie('oa_ad_clids', oaJson, 7776000);
        safeLocalStorageSet('oa_ad_clids', oaJson);
      }

      var impactClickId = params.get('im_ref');
      if (impactClickId) {
        safeLocalStorageSet('impact_clickid', impactClickId);
        postImpactClickId(impactClickId);
      }

      var impactPartnerId = params.get('irpid');
      if (impactPartnerId) {
        safeLocalStorageSet('impact_irpid', impactPartnerId);
      }

      if (isProductionHost) {
        loadTolt();
      }
    } catch (_err) {}
  })();
