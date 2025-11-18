import type { RouteMatch } from './routeMatcher.js'

export interface ProxyRequest {
  method: string
  path: string
  headers: Record<string, string | string[]>
  query?: Record<string, string | string[]>
  body?: any
}

export interface ProxyResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: any
}

export interface ProxyOptions {
  timeout?: number // milliseconds
  followRedirects?: boolean
  maxRedirects?: number
}

/**
 * Request Proxy Service
 * Handles proxying HTTP requests to target URLs
 */
export class RequestProxy {
  private defaultTimeout: number = 30000 // 30 seconds
  private defaultMaxRedirects: number = 5

  constructor(private options: ProxyOptions = {}) {
    if (options.timeout) {
      this.defaultTimeout = options.timeout
    }
  }

  /**
   * Build query string from query parameters
   */
  private buildQueryString(query?: Record<string, string | string[]>): string {
    if (!query || Object.keys(query).length === 0) {
      return ''
    }

    const params = new URLSearchParams()

    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        value.forEach(v => params.append(key, v))
      } else {
        params.append(key, value)
      }
    }

    return params.toString()
  }

  /**
   * Build full target URL with query parameters
   */
  private buildFullUrl(baseUrl: string, queryString: string): string {
    if (!queryString) {
      return baseUrl
    }

    const separator = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${separator}${queryString}`
  }

  /**
   * Filter and normalize headers for proxying
   * Removes hop-by-hop headers and adds X-Forwarded-* headers
   */
  private prepareHeaders(
    headers: Record<string, string | string[]>,
    originalHost: string
  ): Record<string, string> {
    const proxyHeaders: Record<string, string> = {}

    // Headers to skip (hop-by-hop headers)
    const skipHeaders = new Set([
      'host',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ])

    // Copy headers, converting arrays to comma-separated strings
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase()

      if (skipHeaders.has(lowerKey)) {
        continue
      }

      if (Array.isArray(value)) {
        proxyHeaders[key] = value.join(', ')
      } else {
        proxyHeaders[key] = value
      }
    }

    // Add X-Forwarded headers
    proxyHeaders['X-Forwarded-For'] = headers['x-forwarded-for']
      ? `${headers['x-forwarded-for']}`
      : originalHost
    proxyHeaders['X-Forwarded-Host'] = originalHost
    proxyHeaders['X-Forwarded-Proto'] = 'https'

    return proxyHeaders
  }

  /**
   * Proxy a request to the target URL
   */
  async proxy(
    match: RouteMatch,
    request: ProxyRequest,
    targetUrl: string
  ): Promise<ProxyResponse> {
    const queryString = this.buildQueryString(request.query)
    const fullUrl = this.buildFullUrl(targetUrl, queryString)

    // Prepare headers
    const proxyHeaders = this.prepareHeaders(
      request.headers,
      request.headers['host'] as string
    )

    // Set up timeout
    const timeout = this.options.timeout || this.defaultTimeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      // Make proxied request
      const response = await fetch(fullUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
        redirect: this.options.followRedirects !== false ? 'follow' : 'manual',
      })

      clearTimeout(timeoutId)

      // Extract response headers
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // Parse response body
      let responseBody
      const contentType = response.headers.get('content-type')

      if (contentType?.includes('application/json')) {
        try {
          responseBody = await response.json()
        } catch {
          responseBody = await response.text()
        }
      } else {
        responseBody = await response.text()
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      }
    } catch (error) {
      clearTimeout(timeoutId)

      // Handle timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProxyError(
          `Request to ${targetUrl} timed out after ${timeout}ms`,
          504,
          error
        )
      }

      // Handle network errors
      if (error instanceof TypeError) {
        throw new ProxyError(`Failed to connect to ${targetUrl}`, 502, error)
      }

      // Re-throw other errors
      throw new ProxyError(
        `Proxy request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        500,
        error instanceof Error ? error : undefined
      )
    }
  }
}

/**
 * Custom error for proxy failures
 */
export class ProxyError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public cause?: Error
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}
