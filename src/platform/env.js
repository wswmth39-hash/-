'use strict';
// طبقة المنصة — فحص سلبي لبيئة الصفحة: هل أنشأت الصفحة Worker/SharedWorker (قد تُفتح اتصالات الأسعار داخله حيث لا يصل
// مراقب WebSocket في الصفحة)، وكم إطار iframe فيها. لا يُحقن شيء في أي Worker أو iframe، ولا يُعدَّل سلوكها.
function installEnvProbe(win, onChange) {
  const st = { workers: 0, sharedWorkers: 0, workerHosts: {}, frames: 0, frameHosts: {} };
  const hostOf = u => { try { return new URL(String(u), win.location && win.location.href).host || 'blob'; } catch (e) { return 'غير معروف'; } };
  const wrap = (name, key) => {
    const Native = win[name];
    if (typeof Native !== 'function' || Native.__wsnfProbe) return;
    const P = function (url, opts) {
      st[key]++; const h = hostOf(url); st.workerHosts[h] = (st.workerHosts[h] || 0) + 1;
      try { onChange(snapshot()); } catch (e) {}
      return opts !== undefined ? new Native(url, opts) : new Native(url);
    };
    P.prototype = Native.prototype;
    Object.defineProperty(P, '__wsnfProbe', { value: true });
    try { win[name] = P; } catch (e) {}
  };
  wrap('Worker', 'workers');
  wrap('SharedWorker', 'sharedWorkers');
  function snapshot() {
    try {
      const fr = win.document ? win.document.querySelectorAll('iframe') : [];
      st.frames = fr.length; st.frameHosts = {};
      for (const f of fr) { const h = hostOf(f.src || 'about:blank'); st.frameHosts[h] = (st.frameHosts[h] || 0) + 1; }
    } catch (e) {}
    return { workers: st.workers + st.sharedWorkers, workerHosts: { ...st.workerHosts }, frames: st.frames, frameHosts: { ...st.frameHosts } };
  }
  return { snapshot };
}
module.exports = { installEnvProbe };
