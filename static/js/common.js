/**
 * 公共 API 工具模块
 */

const API_BASE = '.';

/**
 * 从 localStorage 获取认证 Token
 */
function getAuthToken() {
    try {
        const authData = localStorage.getItem('mimusic-auth');
        if (authData) {
            const auth = JSON.parse(authData);
            return auth.accessToken || '';
        }
    } catch (error) {
        console.error('获取 Token 失败:', error);
    }
    return '';
}

/**
 * 构建请求头（含可选的 Authorization）
 */
function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) {
        headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
}

/**
 * 发送 GET 请求并返回 JSON
 */
export function apiGet(path) {
    return fetch(API_BASE + path, {
        method: 'GET',
        headers: buildHeaders()
    }).then(response => response.json());
}

/**
 * 发送 POST 请求并返回 JSON
 */
export function apiPost(path, body) {
    return fetch(API_BASE + path, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body)
    }).then(response => response.json());
}

/**
 * 发送 DELETE 请求并返回 JSON
 */
export function apiDelete(path) {
    return fetch(API_BASE + path, {
        method: 'DELETE',
        headers: buildHeaders()
    }).then(response => response.json());
}