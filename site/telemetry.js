// One anonymous, best-effort PurplePulse ping per browser install and local day.
;(function () {
  'use strict'

  var ENDPOINT = 'https://pulse-api.purpleshiphub.workers.dev/api/v1/ping'
  var PROJECT_ID = 'pp_capturepack_6bede657'
  var SITE_VERSION = '0.6.0'
  var INSTALL_KEY = 'capturepack_purplepulse_install_id'
  var DAY_KEY = 'capturepack_purplepulse_day'
  var TIMEOUT_MS = 2500
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  function localDay(now) {
    return [
      String(now.getFullYear()).padStart(4, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
  }

  function browserOs(nav) {
    var platform = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '')
    var userAgent = String(nav.userAgent || '')
    if (/android/i.test(platform) || /android/i.test(userAgent)) return 'android'
    if (/iphone|ipad|ipod/i.test(platform) || /iphone|ipad|ipod/i.test(userAgent) ||
        (/mac/i.test(platform) && Number(nav.maxTouchPoints) > 1)) return 'ios'
    if (/win/i.test(platform)) return 'windows'
    if (/mac/i.test(platform)) return 'macos'
    if (/linux/i.test(platform)) return 'linux'
    return 'other'
  }

  function newInstallId(cryptoApi) {
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
    if (typeof cryptoApi.getRandomValues !== 'function') return null
    var bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    var hex = Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0')
    }).join('')
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
  }

  async function send() {
    try {
      var today = localDay(new Date())
      var installId = localStorage.getItem(INSTALL_KEY)
      if (!installId || !UUID_PATTERN.test(installId)) {
        installId = newInstallId(crypto)
        if (!installId || !UUID_PATTERN.test(installId)) return
        localStorage.setItem(INSTALL_KEY, installId)
      }
      if (localStorage.getItem(DAY_KEY) === today) return
      // Persist before fetch: an outage must not retry on every page view.
      localStorage.setItem(DAY_KEY, today)

      var controller = new AbortController()
      var timeout = setTimeout(function () { controller.abort() }, TIMEOUT_MS)
      try {
        await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: PROJECT_ID,
            install_id: installId,
            version: SITE_VERSION,
            os: browserOs(navigator),
            platform: 'web'
          }),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeout)
      }
    } catch (e) {
      // Telemetry is intentionally invisible and never affects the page.
    }
  }

  void send()
})()
