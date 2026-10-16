// ─── Client-Side Analytics Tracker ───────────────────────────────────────────
// Lightweight (~1KB minified) tracker script served at GET /tracker.js.
// Features:
//   - Auto page view on load
//   - sendBeacon on visibilitychange for time-on-page
//   - UTM parameter extraction from URL
//   - Custom event tracking via window.manhali.track(name)
//   - Site ID for tenant identification
//   - No cookies, no localStorage, no fingerprinting on client side

/**
 * Returns the tracker script as a string.
 * The script is parameterized with the collect endpoint URL and site ID.
 *
 * @param collectEndpoint - Full URL to the /api/collect endpoint
 * @param siteId - Tenant site ID for attribution (empty string if not provided)
 */
export function getTrackerScript(
  collectEndpoint: string,
  siteId: string,
): string {
  // Sanitize to prevent script injection via query parameters
  const safeEndpoint = collectEndpoint.replace(/[^a-zA-Z0-9:/_.\.\-]/g, "");
  const safeSid = siteId.replace(/[^a-zA-Z0-9_\-.:]/g, "");
  const endpointLiteral = JSON.stringify(safeEndpoint);
  const sidLiteral = JSON.stringify(safeSid);

  return `(function(){
"use strict";
if(window.manhali)return;
var e=${endpointLiteral},sid=${sidLiteral},t=Date.now(),n=document.referrer,lp=location.pathname,bs=false;
var _us,_um,_uc;
function utm(){
  var m=new URLSearchParams(location.search);
  _us=m.get("utm_source");_um=m.get("utm_medium");_uc=m.get("utm_campaign");
}
utm();

function p(a,o,en,pp){
  var d={t:a,p:pp||location.pathname,r:n};
  if(sid)d.sid=sid;
  if(o)d.d=o;
  if(en)d.en=en;
  if(_us)d.us=_us;
  if(_um)d.um=_um;
  if(_uc)d.uc=_uc;
  return d;
}
function tx(d){
  try{
    var b=JSON.stringify(d);
    if(navigator.sendBeacon&&navigator.sendBeacon(e,b))return;
    if(window.fetch){
      fetch(e,{method:"POST",body:b,keepalive:true,mode:"cors",headers:{"Content-Type":"text/plain;charset=UTF-8"}}).catch(function(){});
    }else{
      var x=new XMLHttpRequest();
      x.open("POST",e,true);
      x.setRequestHeader("Content-Type","text/plain;charset=UTF-8");
      x.send(b);
    }
  }catch(err){}
}
function s(a,o,en,pp){tx(p(a,o,en,pp))}

// A session under ~0.5s has no time-on-page to report; leaving the beacon flag
// unset means a later hide (after the visitor stays longer) still beacons.
function beacon(){
  if(bs)return null;
  var dur=Math.round((Date.now()-t)/1000);
  if(dur<=0)return null;
  bs=true;
  return p("beacon",dur,0,lp);
}
function sendBeacon(){var d=beacon();if(d)tx(d)}

s("pageview");

document.addEventListener("visibilitychange",function(){
  if(document.visibilityState==="hidden")sendBeacon();
});
window.addEventListener("pagehide",sendBeacon);
window.addEventListener("pageshow",function(ev){
  if(ev.persisted){
    bs=false;t=Date.now();n="";utm();s("pageview");
  }
});

function onNav(){
  if(location.pathname!==lp){
    var previous=beacon();
    lp=location.pathname;
    t=Date.now();
    n="";
    bs=false;
    utm();
    var next=p("pageview");
    tx(previous?{events:[previous,next]}:next);
  }
}
var oP=history.pushState;
history.pushState=function(){oP.apply(this,arguments);onNav()};
var oR=history.replaceState;
history.replaceState=function(){oR.apply(this,arguments);onNav()};
window.addEventListener("popstate",onNav);

window.manhali={track:function(name){s("event",0,name||"custom")},pageview:function(){s("pageview")}};
})();`;
}

/**
 * Returns the Content-Type and cache headers for the tracker script.
 * 1-hour cache with stale-while-revalidate for fast propagation of updates.
 */
export function getTrackerHeaders(): HeadersInit {
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
}
