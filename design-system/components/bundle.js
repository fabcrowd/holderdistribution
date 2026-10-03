/* @ds-bundle: {"format":4,"namespace":"HolderAnalytics","components":[{"name":"Button"},{"name":"Badge"},{"name":"StatCard"}]} */
(function () {
  var h = window.React.createElement;

  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i]) out.push(arguments[i]);
    }
    return out.join(' ');
  }

  function Button(props) {
    var variant = props.variant || 'secondary';
    var rest = {};
    for (var k in props) {
      if (k !== 'variant' && k !== 'className' && k !== 'children') rest[k] = props[k];
    }
    rest.className = cx('ha-btn', 'ha-btn-' + variant, props.className);
    return h('button', rest, props.children);
  }

  function Badge(props) {
    var tone = props.tone || 'neutral';
    return h('span', { className: 'ha-badge ha-badge-' + tone }, props.children);
  }

  function StatCard(props) {
    var trend = props.trend || 'flat';
    var children = [
      h('div', { className: 'ha-stat-label', key: 'l' }, props.label),
      h('div', { className: 'ha-stat-value', key: 'v' }, props.value)
    ];
    if (props.change) {
      children.push(h('div', { className: 'ha-stat-change ha-stat-change-' + trend, key: 'c' }, props.change));
    }
    return h('div', { className: 'ha-stat' }, children);
  }

  var ns = window.HolderAnalytics || {};
  ns.Button = Button;
  ns.Badge = Badge;
  ns.StatCard = StatCard;
  window.HolderAnalytics = ns;
})();
