import Script from 'next/script'

/**
 * Google Tag Manager container loader.
 *
 * Renders nothing unless NEXT_PUBLIC_GTM_ID is set, so local development and
 * preview builds never write into the production container. The ID is public by
 * design — it ships in the page source of every site that uses GTM.
 */
const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID

export function GoogleTagManagerScript() {
  if (!GTM_ID) return null
  return (
    <Script id="gtm-loader" strategy="afterInteractive">
      {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`}
    </Script>
  )
}

/** The no-JavaScript fallback. Must be the first element inside <body>. */
export function GoogleTagManagerNoScript() {
  if (!GTM_ID) return null
  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
        title="Google Tag Manager"
      />
    </noscript>
  )
}
