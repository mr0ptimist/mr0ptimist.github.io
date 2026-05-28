window.GpuGraph = (function () {
  var _nets = {}; // canvasId -> { network, frozen }

  function _isDark() {
    return document.documentElement.classList.contains('dark');
  }

  function _makeOptions() {
    var dark = _isDark();
    return {
      nodes: {
        font: { size: 12, color: dark ? '#ddd' : '#222' },
        borderWidth: 1,
        margin: { top: 5, bottom: 5, left: 8, right: 8 },
      },
      edges: {
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: {
          color: dark ? '#555' : '#bbb',
          highlight: dark ? '#aaa' : '#555',
          inherit: false,
        },
        smooth: { type: 'curvedCW', roundness: 0.2 },
        width: 1,
        selectionWidth: 2,
      },
      physics: {
        enabled: false,
        barnesHut: {
          gravitationalConstant: -6000,
          centralGravity: 0.2,
          springLength: 130,
          springConstant: 0.04,
          damping: 0.1,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 120,
        selectConnectedEdges: true,
        hoverConnectedEdges: true,
        navigationButtons: false,
        multiselect: true,
      },
      groups: {
        drawcall: {
          shape: 'box',
          color: { background: '#4a90d9', border: '#2c6fad',
                   highlight: { background: '#6aaff0', border: '#1a5090' },
                   hover: { background: '#6aaff0', border: '#2c6fad' } },
          font: { color: '#fff', size: 11 },
        },
        dispatch: {
          shape: 'box',
          color: { background: '#5cb85c', border: '#3d8b3d',
                   highlight: { background: '#7dd87d', border: '#2a6b2a' },
                   hover: { background: '#7dd87d', border: '#3d8b3d' } },
          font: { color: '#fff', size: 11 },
        },
        uav: {
          shape: 'ellipse',
          color: { background: '#f0ad4e', border: '#c87d1e',
                   highlight: { background: '#f8c87a', border: '#a06010' },
                   hover: { background: '#f8c87a', border: '#c87d1e' } },
          font: { color: '#fff', size: 11 },
        },
        rt: {
          shape: 'ellipse',
          color: { background: '#d9534f', border: '#b52b27',
                   highlight: { background: '#e87470', border: '#901e1b' },
                   hover: { background: '#e87470', border: '#b52b27' } },
          font: { color: '#fff', size: 11 },
        },
        shader: {
          shape: 'diamond',
          color: { background: '#9b59b6', border: '#7d3f9a',
                   highlight: { background: '#b87fcc', border: '#602d7a' },
                   hover: { background: '#b87fcc', border: '#7d3f9a' } },
          font: { color: '#fff', size: 11 },
        },
        grphdr: {
          shape: 'ellipse',
          color: { background: '#555', border: '#333',
                   highlight: { background: '#777', border: '#222' },
                   hover: { background: '#777', border: '#333' } },
          font: { color: '#fff', size: 10 },
        },
      },
    };
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function init(canvasId, infoId, ubiqId, data) {
    var container = document.getElementById(canvasId);
    if (!container) return;

    var infoEl = document.getElementById(infoId);
    if (infoEl) {
      var meta = data.meta || {};
      var totalActions = meta.total_actions ||
        data.nodes.filter(function (n) {
          return n.group === 'drawcall' || n.group === 'dispatch';
        }).length;
      var resCount = data.nodes.filter(function (n) {
        return n.group === 'uav' || n.group === 'rt' || n.group === 'shader';
      }).length;
      infoEl.textContent = totalActions + ' GPU Actions · ' + resCount + ' 资源节点';
      if (meta.capture) infoEl.textContent += ' · ' + meta.capture;
    }

    var ubiqEl = document.getElementById(ubiqId);
    if (ubiqEl) {
      if (data.ubiquitous && data.ubiquitous.length) {
        ubiqEl.innerHTML =
          '⚡ <b>全局资源（已隐藏）：</b>' +
          data.ubiquitous.map(function (n) {
            return '<code>' + _esc(n) + '</code>';
          }).join(' · ');
      } else {
        ubiqEl.style.display = 'none';
      }
    }

    var nodes = new vis.DataSet(data.nodes);
    var edges = new vis.DataSet(data.edges);
    var network = new vis.Network(
      container, { nodes: nodes, edges: edges }, _makeOptions()
    );
    // physics starts disabled; mark as frozen
    _nets[canvasId] = { network: network, frozen: true };

    // Update button to reflect initial state
    var btnId = canvasId.replace('ggraph-', 'ggbtn-phys-');
    var btn = document.getElementById(btnId);
    if (btn) btn.textContent = '启用物理';
  }

  function togglePhysics(canvasId, btn) {
    var entry = _nets[canvasId];
    if (!entry) return;
    entry.frozen = !entry.frozen;
    entry.network.setOptions({ physics: { enabled: !entry.frozen } });
    if (btn) btn.textContent = entry.frozen ? '启用物理' : '冻结布局';
  }

  function fit(canvasId) {
    var entry = _nets[canvasId];
    if (entry) {
      entry.network.fit({
        animation: { duration: 400, easingFunction: 'easeInOutQuad' },
      });
    }
  }

  return { init: init, togglePhysics: togglePhysics, fit: fit };
}());
