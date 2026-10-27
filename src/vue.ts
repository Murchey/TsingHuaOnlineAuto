export interface VNode {
  el?: Node;
  component?: Component;
  children?: unknown;
  suspense?: { activeBranch?: VNode };
}

export interface Component {
  type?: { name?: string; __name?: string };
  props: Record<string, unknown>;
  subTree?: VNode;
  vnode?: VNode;
  parent?: Component;
  isUnmounted?: boolean;
}

type VueElement = Element & {
  _vnode?: VNode;
  __vueParentComponent?: Component;
  __vue_app__?: { _container?: VueElement; _instance?: Component };
};

export const nameOf = (c: Component): string => c.type?.__name || c.type?.name || '';

// Production Vue does not expose __vueParentComponent. The app container still owns its root VNode.
export function components(doc: Document = document): Component[] {
  const result: Component[] = [];
  const visited = new Set<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || visited.has(node) || visited.size > 40_000) return;
    visited.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const v = node as VNode;
    if (v.component && !v.component.isUnmounted) {
      result.push(v.component);
      walk(v.component.subTree);
    }
    walk(v.children);
    walk(v.suspense?.activeBranch);
  };
  // Vue's own public mount marker also handles applications that use a different root id.
  for (const el of doc.querySelectorAll('#app,[data-v-app]')) {
    const root = el as VueElement;
    walk(root._vnode || root.__vue_app__?._container?._vnode);
    const instance = root.__vue_app__?._instance;
    if (instance) walk({ component: instance });
  }
  return [...new Set(result)];
}

export function elementOf(c: Component): HTMLElement | undefined {
  const el = c.subTree?.el || c.vnode?.el;
  if (el instanceof HTMLElement) return el;
  return undefined;
}
