// 小米音箱插件 - HTTP工具
// 基于 QuickJS 全局 fetch API，提供手动重定向跟踪和宿主API调用

/// <reference types="@mimusic/plugin-sdk" />

import { CookieJar, parseCookies } from './cookie';

/** fetch请求选项（扩展） */
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}

/** 重定向跟踪结果 */
export interface RedirectResult {
  response: Response;
  finalUrl: string;
  redirectCount: number;
}

/**
 * 带Cookie跟踪的重定向请求
 * 小米登录流程涉及多次3xx重定向，每步需要收集并回传Cookie
 *
 * @param url - 请求URL
 * @param options - 请求选项
 * @param cookieJar - Cookie管理器
 * @param maxRedirects - 最大重定向次数（默认10）
 * @returns 最终响应和URL
 */
export async function fetchWithRedirects(
  url: string,
  options: FetchOptions = {},
  cookieJar: CookieJar,
  maxRedirects = 10,
): Promise<RedirectResult> {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    // 构建带Cookie的请求头
    const headers: Record<string, string> = { ...(options.headers || {}) };
    const cookieHeader = cookieJar.getCookieHeader(currentUrl);
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const fetchInit: RequestInit = {
      method: redirectCount === 0 ? (options.method || 'GET') : 'GET',
      headers,
      redirect: 'manual',
    };

    // 只在第一次请求时携带body
    if (redirectCount === 0 && options.body) {
      fetchInit.body = options.body;
    }

    const response = await fetch(currentUrl, fetchInit);

    // 收集Set-Cookie响应头
    collectCookies(response, currentUrl, cookieJar);

    // 检查是否为重定向
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        // 没有Location头，返回当前响应
        return { response, finalUrl: currentUrl, redirectCount };
      }

      // 处理相对路径的Location
      currentUrl = resolveUrl(currentUrl, location);
      redirectCount++;
      continue;
    }

    // 非重定向响应
    return { response, finalUrl: currentUrl, redirectCount };
  }

  throw new Error(`Too many redirects (max: ${maxRedirects})`);
}

/**
 * 从Response中收集Set-Cookie头并添加到CookieJar
 */
function collectCookies(response: Response, url: string, cookieJar: CookieJar): void {
  // QuickJS的Headers可能不支持getSetCookie()，尝试多种方式
  const setCookieHeaders: string[] = [];

  // 方式1：尝试 getSetCookie()（标准API）
  if (typeof (response.headers as any).getSetCookie === 'function') {
    const cookies = (response.headers as any).getSetCookie() as string[];
    setCookieHeaders.push(...cookies);
  }
  // 方式2：尝试 get('set-cookie')，可能返回逗号分隔的多个值
  else {
    const raw = response.headers.get('set-cookie');
    if (raw) {
      // 简单按逗号分隔，但注意expires字段中也有逗号
      // 使用更安全的分割方式：按 ", " + 非空白字符 + "=" 来分割
      setCookieHeaders.push(...splitSetCookieHeader(raw));
    }
  }

  if (setCookieHeaders.length > 0) {
    const cookies = parseCookies(setCookieHeaders, url);
    cookieJar.add(cookies);
  }
}

/**
 * 分割合并在一起的Set-Cookie头
 * HTTP/1.1中多个Set-Cookie可能被合并为逗号分隔的单个头
 */
function splitSetCookieHeader(header: string): string[] {
  const result: string[] = [];
  let current = '';
  let i = 0;

  while (i < header.length) {
    // 查找逗号
    const commaIdx = header.indexOf(',', i);
    if (commaIdx === -1) {
      current += header.slice(i);
      break;
    }

    // 检查逗号后面的内容是否像一个新的cookie（name=value 模式）
    const afterComma = header.slice(commaIdx + 1).trimStart();
    // 如果逗号后面像一个新cookie的开始（包含=且在;之前）
    const eqIdx = afterComma.indexOf('=');
    const semiIdx = afterComma.indexOf(';');
    const spaceIdx = afterComma.indexOf(' ');

    if (eqIdx > 0 && (semiIdx === -1 || eqIdx < semiIdx) && (spaceIdx === -1 || eqIdx < spaceIdx || spaceIdx > 0)) {
      // 可能是新cookie的开始，但也可能是 expires 中的日期逗号
      // 检查逗号之前的内容是否像日期（包含日期关键词）
      const beforeComma = header.slice(i, commaIdx);
      if (isDateFragment(beforeComma)) {
        // 是日期中的逗号，不分割
        current += header.slice(i, commaIdx + 1);
        i = commaIdx + 1;
      } else {
        // 是cookie分隔符
        current += header.slice(i, commaIdx);
        result.push(current.trim());
        current = '';
        i = commaIdx + 1;
      }
    } else {
      // 逗号不是分隔符（可能在日期或值中）
      current += header.slice(i, commaIdx + 1);
      i = commaIdx + 1;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * 检查字符串是否像日期片段（如 "Mon, 01 Jan..."中逗号前的部分）
 */
function isDateFragment(str: string): boolean {
  const trimmed = str.trim();
  // expires= 后面跟的日期格式中，逗号前通常是星期几缩写
  const lastPart = trimmed.split(';').pop()?.trim() || '';
  // 检查是否匹配 "expires=Xxx" 或 以3字母星期结尾
  return /expires\s*=\s*\w{3}$/i.test(lastPart) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(lastPart);
}

/**
 * 解析相对URL为绝对URL
 */
function resolveUrl(base: string, relative: string): string {
  // 已经是绝对URL
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }

  // 协议相对URL
  if (relative.startsWith('//')) {
    const proto = base.startsWith('https') ? 'https:' : 'http:';
    return proto + relative;
  }

  // 提取base的origin和path
  const protoIdx = base.indexOf('://');
  const protoEnd = protoIdx + 3;
  const pathIdx = base.indexOf('/', protoEnd);
  const origin = pathIdx === -1 ? base : base.slice(0, pathIdx);

  if (relative.startsWith('/')) {
    // 绝对路径
    return origin + relative;
  }

  // 相对路径
  const basePath = pathIdx === -1 ? '/' : base.slice(pathIdx);
  const lastSlash = basePath.lastIndexOf('/');
  const dir = basePath.slice(0, lastSlash + 1);
  return origin + dir + relative;
}

/**
 * 快速JSON请求（不跟踪Cookie）
 */
export async function fetchJSON<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const text = await response.text();
  return JSON.parse(text) as T;
}

// ===== 宿主API调用 =====

/** pluginToken用于宿主API认证，初始化时设置 */
let _pluginToken = '';

/**
 * 设置宿主API的pluginToken
 * 应在onInit时调用
 */
export function setPluginToken(token: string): void {
  _pluginToken = token;
}

/**
 * 获取当前pluginToken
 */
export function getPluginToken(): string {
  return _pluginToken;
}

/**
 * 获取宿主API基础URL
 */
export function getHostBaseUrl(): string {
  return _hostBaseUrl;
}

/** 宿主API基础URL，初始化时设置 */
let _hostBaseUrl = '';

/**
 * 设置宿主API基础URL
 * @param url - 例如 "http://127.0.0.1:58091"
 */
export function setHostBaseUrl(url: string): void {
  _hostBaseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * 调用MiMusic宿主API
 * @param method - HTTP方法
 * @param path - API路径（如 /api/v1/songs）
 * @param body - 请求体（将被JSON序列化）
 * @returns 解析后的JSON响应
 */
export async function callHostAPI<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!_hostBaseUrl) {
    throw new Error('Host base URL not set. Call setHostBaseUrl() first.');
  }
  if (!_pluginToken) {
    throw new Error('Plugin token not set. Call setPluginToken() first.');
  }

  const url = _hostBaseUrl + path;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${_pluginToken}`,
    'Accept': 'application/json',
  };

  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: bodyStr,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Host API error ${response.status} ${method} ${path}: ${text}`);
  }

  return text ? JSON.parse(text) as T : (undefined as unknown as T);
}
