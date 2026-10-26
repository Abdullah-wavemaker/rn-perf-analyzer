import { XMLParser } from 'fast-xml-parser';
import { AppError } from '../errors.js';

export interface UiNode {
  id: number;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  packageName: string;
  clickable: boolean;
  scrollable: boolean;
  enabled: boolean;
  bounds: [number, number, number, number];
}

export interface UiSnapshot {
  width: number;
  height: number;
  foregroundPackage: string | null;
  nodes: UiNode[];
}

const MAX_NODES = 20_000;

interface RawNode {
  text?: string;
  'resource-id'?: string;
  'content-desc'?: string;
  class?: string;
  package?: string;
  clickable?: string;
  'long-clickable'?: string;
  scrollable?: string;
  enabled?: string;
  bounds?: string;
  node?: RawNode[];
}

/**
 * Parses a uiautomator dump. The XML comes from the device and is treated as
 * untrusted: DOCTYPE/ENTITY declarations are rejected outright and node count
 * is capped.
 */
export function parseUiDump(xml: string, screen: { width: number; height: number }): UiSnapshot {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError(502, 'UI_DUMP_INVALID', 'Unexpected DOCTYPE in UI dump');
  const start = xml.indexOf('<?xml') !== -1 ? xml.indexOf('<?xml') : xml.indexOf('<hierarchy');
  const end = xml.lastIndexOf('</hierarchy>');
  if (start === -1 || end === -1) throw new AppError(502, 'UI_DUMP_INVALID', 'UI dump is not a hierarchy document');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: true,
    htmlEntities: false,
    parseAttributeValue: false,
    isArray: (name) => name === 'node',
  });
  const doc = parser.parse(xml.slice(start, end + '</hierarchy>'.length)) as { hierarchy?: { node?: RawNode[] } };
  const nodes: UiNode[] = [];
  const stack: RawNode[] = [...(doc.hierarchy?.node ?? [])].reverse();
  let foregroundPackage: string | null = null;
  while (stack.length > 0 && nodes.length < MAX_NODES) {
    const raw = stack.pop() as RawNode;
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(raw.bounds ?? '');
    if (b) {
      const node: UiNode = {
        id: nodes.length,
        text: String(raw.text ?? '').slice(0, 300),
        resourceId: String(raw['resource-id'] ?? '').slice(0, 300),
        contentDesc: String(raw['content-desc'] ?? '').slice(0, 300),
        className: String(raw.class ?? '').slice(0, 200),
        packageName: String(raw.package ?? ''),
        clickable: raw.clickable === 'true' || raw['long-clickable'] === 'true',
        scrollable: raw.scrollable === 'true',
        enabled: raw.enabled !== 'false',
        bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
      };
      if (foregroundPackage === null && node.packageName) foregroundPackage = node.packageName;
      nodes.push(node);
    }
    const children = raw.node ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as RawNode);
  }
  return { width: screen.width, height: screen.height, foregroundPackage, nodes };
}

export function center(node: UiNode): { x: number; y: number } {
  return { x: Math.round((node.bounds[0] + node.bounds[2]) / 2), y: Math.round((node.bounds[1] + node.bounds[3]) / 2) };
}

export function area(node: UiNode): number {
  return Math.max(0, node.bounds[2] - node.bounds[0]) * Math.max(0, node.bounds[3] - node.bounds[1]);
}

export function label(node: UiNode): string {
  return node.text || node.contentDesc || node.resourceId.split('/').pop() || node.className.split('.').pop() || 'element';
}

/** Deepest clickable node containing the point — what a tap at (x, y) most likely hits. */
export function nodeAt(snapshot: UiSnapshot, x: number, y: number): UiNode | null {
  let best: UiNode | null = null;
  for (const n of snapshot.nodes) {
    const [x1, y1, x2, y2] = n.bounds;
    if (x < x1 || x > x2 || y < y1 || y > y2) continue;
    if (n.clickable && (!best || area(n) <= area(best))) best = n;
  }
  return best;
}
