/**
 * SortBar — shared sort logic for list.html and section/local.html.
 * Supports both flat (post-entry) and tree (ptree-article) views.
 *
 * Usage: set window.SortBarConfig BEFORE including this script,
 * then call SortBar.init().
 */
(function () {
  var bar = document.querySelector('.sort-bar');
  if (!bar) return;

  var cfg = window.SortBarConfig || {};
  var defaults = cfg.defaults || { name: 'asc', date: 'desc', lastmod: 'desc' };
  var labels = { name: '按名称', date: '按日期', lastmod: '按修改日期' };
  var storageKey = cfg.storageKey || 'blog_sort';

  var treeWrap = document.querySelector('.post-tree-wrap');
  var isTree = !!treeWrap;
  var btns = bar.querySelectorAll('.sort-btn');

  function updateBtns(mode, dir) {
    btns.forEach(function (btn) {
      var m = btn.dataset.sort;
      btn.classList.toggle('active', m === mode);
      btn.textContent = m === mode ? labels[m] + (dir === 'asc' ? ' ↑' : ' ↓') : labels[m];
    });
  }

  /* ── Flat mode sort ── */
  function getFlatArticles() {
    var sel = cfg.flatSelector || '.post-entry';
    return Array.from(document.querySelectorAll(sel));
  }

  function sortFlat(mode, dir) {
    var articles = getFlatArticles();
    articles.sort(function (a, b) {
      var cmp;
      if (mode === 'name')
        cmp = (a.dataset.sortTitle || '').localeCompare(b.dataset.sortTitle || '');
      else if (mode === 'lastmod')
        cmp = (a.dataset.sortLastmod || '').localeCompare(b.dataset.sortLastmod || '');
      else cmp = (a.dataset.sortDate || '').localeCompare(b.dataset.sortDate || '');
      return dir === 'asc' ? cmp : -cmp;
    });
    var ref = bar.nextElementSibling;
    articles.forEach(function (el) { el.parentNode.insertBefore(el, ref); });
  }

  function updateFlatDates(mode) {
    getFlatArticles().forEach(function (el) {
      var span = el.querySelector('.entry-date');
      if (!span) return;
      var val = mode === 'lastmod' ? el.dataset.sortLastmod : el.dataset.sortDate;
      if (val) {
        if (cfg.formatDate) span.textContent = cfg.formatDate(val);
        else span.textContent = val;
      }
    });
  }

  /* ── Tree mode sort ── */
  function treeCompare(a, b, mode) {
    var linkA = a.querySelector('.ptree-link');
    var linkB = b.querySelector('.ptree-link');
    if (mode === 'name') {
      var titleA = linkA ? linkA.querySelector('.ptree-title') : null;
      var titleB = linkB ? linkB.querySelector('.ptree-title') : null;
      return (titleA ? titleA.textContent : '').localeCompare(titleB ? titleB.textContent : '');
    }
    /* date / lastmod: the tree renders only the publish date */
    var dateA = linkA ? linkA.querySelector('.ptree-date') : null;
    var dateB = linkB ? linkB.querySelector('.ptree-date') : null;
    return (dateA ? dateA.textContent : '').localeCompare(dateB ? dateB.textContent : '');
  }

  /* Sort ONE ptree-list in place. ONLY its direct <li.ptree-article> children are
     moved — folder <li>s and the articles inside them stay untouched, so each
     folder keeps exactly its own articles. (Re-appending puts articles after the
     folder <li>s, matching the server-rendered order.) */
  function sortTreeList(list, mode, dir) {
    var articles = [];
    for (var i = 0; i < list.children.length; i++) {
      if (list.children[i].classList.contains('ptree-article')) articles.push(list.children[i]);
    }
    if (articles.length < 2) return;
    articles.sort(function (a, b) {
      var cmp = treeCompare(a, b, mode);
      return dir === 'asc' ? cmp : -cmp;
    });
    articles.forEach(function (el) { list.appendChild(el); });
  }

  function sortAllTrees(mode, dir) {
    var lists = treeWrap.querySelectorAll('.ptree-list');
    for (var i = 0; i < lists.length; i++) sortTreeList(lists[i], mode, dir);
  }

  /* ── Init ── */
  var savedRaw = sessionStorage.getItem(storageKey) || cfg.defaultKey || 'date_desc';
  var parts = savedRaw.split('_');
  var curMode = (parts[0] in defaults) ? parts[0] : Object.keys(defaults)[0];
  var curDir = (parts[1] === 'asc' || parts[1] === 'desc') ? parts[1] : defaults[curMode];

  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.dataset.sort;
      curDir = (mode === curMode) ? (curDir === 'asc' ? 'desc' : 'asc') : defaults[mode];
      curMode = mode;
      sessionStorage.setItem(storageKey, curMode + '_' + curDir);
      if (isTree) sortAllTrees(curMode, curDir);
      else { sortFlat(curMode, curDir); updateFlatDates(curMode); }
      updateBtns(curMode, curDir);
    });
  });

  updateBtns(curMode, curDir);
  var initialOk = cfg.initial || { mode: 'date', dir: 'desc' };
  if (isTree && !(curMode === initialOk.mode && curDir === initialOk.dir)) sortAllTrees(curMode, curDir);
  else if (!isTree && !(curMode === initialOk.mode && curDir === initialOk.dir)) {
    sortFlat(curMode, curDir);
    updateFlatDates(curMode);
  }
})();
