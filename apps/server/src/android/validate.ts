import { badRequest } from '../errors.js';

/**
 * `adb shell a b c` joins its arguments with spaces and runs them through the
 * device's /system/bin/sh. Any value that reaches that command line must be
 * validated against a strict allow-list — never escaped ad hoc.
 */

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const COMPONENT = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+\/[A-Za-z0-9_.$]+$/;
const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const AVD = /^[A-Za-z0-9._-]{1,128}$/;
const KEYCODE = /^KEYCODE_[A-Z0-9_]{1,40}$/;

export function assertPackage(value: string): string {
  if (!PACKAGE.test(value) || value.length > 255) throw badRequest('Invalid Android package name', 'INVALID_PACKAGE');
  return value;
}

export function assertComponent(value: string): string {
  if (!COMPONENT.test(value) || value.length > 512) throw badRequest('Invalid activity component', 'INVALID_COMPONENT');
  return value;
}

export function assertSerial(value: string): string {
  if (!SERIAL.test(value)) throw badRequest('Invalid device serial', 'INVALID_SERIAL');
  return value;
}

export function assertAvdName(value: string): string {
  if (!AVD.test(value)) throw badRequest('Invalid AVD name', 'INVALID_AVD');
  return value;
}

export function assertKeycode(value: string): string {
  if (!KEYCODE.test(value)) throw badRequest('Invalid key code', 'INVALID_KEYCODE');
  return value;
}

export function assertPid(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 4_194_304) throw badRequest('Invalid pid', 'INVALID_PID');
  return value;
}

/** Integer pixel coordinate / duration for `input` commands. */
export function assertInt(value: number, min: number, max: number, what: string): number {
  const n = Math.round(value);
  if (!Number.isFinite(value) || n < min || n > max) throw badRequest(`Invalid ${what}`, 'INVALID_NUMBER');
  return n;
}

export function isPackage(value: string): boolean {
  return PACKAGE.test(value);
}

export function isComponent(value: string): boolean {
  return COMPONENT.test(value);
}
