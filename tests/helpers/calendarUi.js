const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const React = require('react');
const Renderer = require('react-test-renderer');
const ts = require('typescript');
const {act} = Renderer;

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler);},
    removeEventListener(type, handler) {listeners.get(type)?.delete(handler);},
    emit(type) {for (const handler of listeners.get(type) || []) handler();},
  };
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children || []).map(text).join('');
}
async function flush(action) {
  await act(async () => {action?.(); await new Promise(resolve => setImmediate(resolve));});
}

async function calendarUi({initial, tz = '+00:00'} = {}) {
  const clock = {value: Date.parse('2026-11-17T12:00:00Z')};
  class Clock extends Date {
    constructor(...args) {super(...(args.length ? args : [clock.value]));}
    static now() {return clock.value;}
  }
  const window = eventTarget();
  const document = {...eventTarget(), visibilityState: 'visible'};
  const telegram = eventTarget();
  window.Telegram = {WebApp: {onEvent: telegram.addEventListener, offEvent: telegram.removeEventListener}};
  const requests = [];
  const fetch = (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({url, options, method: options.method || 'GET', resolve, reject, finished: false});
  });
  const filename = path.resolve(__dirname, '../../pages/calendar.js');
  const module = {exports: {}};
  const timeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../lib/time.js'), 'utf8'), {module: timeModule, Date: Clock});
  const localRequire = createRequire(filename);
  const source = fs.readFileSync(process.env.CALENDAR_PAGE_SOURCE || filename, 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  }}).outputText;
  vm.runInNewContext(compiled + '\nmodule.exports.internals = {Planner, Form, Row, Move};', {
    module, exports: module.exports, Date: Clock, window, document, fetch, console, setTimeout, clearTimeout,
    require: name => name === '../lib/time' ? timeModule.exports : ['next/head', 'next/script'].includes(name)
      ? (() => null) : localRequire(name),
  }, {filename});
  const {Planner, Form, Row, Move} = module.exports.internals;
  let renderer;
  await flush(() => {renderer = Renderer.create(React.createElement(Planner, {initData: 'fake-auth', tzOffset: tz}));});
  const f = {
    clock, window, document, telegram, requests, Form, Row, Move,
    root: () => renderer.root,
    content: () => text(renderer.root),
    forms: () => renderer.root.findAllByType(Form),
    buttons: () => renderer.root.findAllByType('button'),
    button: label => renderer.root.findAllByType('button').find(node => text(node) === label),
    input: placeholder => renderer.root.findAllByType('input').find(node => node.props.placeholder === placeholder),
    pending: method => requests.filter(r => !r.finished && r.method === method),
    async click(node) {await flush(() => {node.props.onClick();});},
    async change(node, value) {await flush(() => node.props.onChange({target: {value}}));},
    async reply(request, data, status = 200) {
      await flush(() => {request.finished = true; request.resolve({ok: status >= 200 && status < 300, status, json: async () => data});});
    },
    async reject(request) {await flush(() => {request.finished = true; request.reject(new TypeError('Failed to fetch'));});},
    async emit(target, type) {await flush(() => target.emit(type));},
    async openAdd() {await f.click(f.buttons().find(b => b.props['aria-label'] === 'Добавить дело'));},
    async openEdit() {
      const row = renderer.root.findAllByType(Row)[0];
      await f.click(row.findAllByType('div').find(node => node.props.onClick));
    },
    async unmount() {await flush(() => renderer.unmount());},
  };
  if (initial) {
    // Strict-mode/range effects may initiate more than one request; the latest response owns the list.
    for (const req of [...f.pending('GET')]) await f.reply(req, {events: initial});
  }
  return f;
}
const calendarEvent = (overrides = {}) => ({id: 1, title: 'Исходное дело', emoji: '📌', eventAt: '2026-11-17T14:00:00.000Z',
  hasReminder: true, remindOffsetMinutes: 60, recurring: false, done: false, doneAt: null, ...overrides});

module.exports = {calendarUi, calendarEvent, text, flush};
