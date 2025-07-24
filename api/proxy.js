import { CONFIG } from '../config.js'

export const config = {
  runtime: 'edge',
}

// 检查文件扩展名是否被允许
function isAllowedFileType(url) {
  // 如果允许列表为空，则不限制文件类型
  if (!CONFIG.ALLOWED_EXTENSIONS || CONFIG.ALLOWED_EXTENSIONS.length === 0) {
    return true
  }
  
  const pathname = new URL(url).pathname
  const extension = pathname.substring(pathname.lastIndexOf('.')).toLowerCase()
  
  // 如果没有扩展名，允许通过（可能是目录或API请求）
  if (!extension || extension === pathname) {
    return true
  }
  
  return CONFIG.ALLOWED_EXTENSIONS.includes(extension)
}

// 从URL中提取GitHub仓库信息
function extractGitHubRepo(url) {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/^\/(gh|github)\/([^\/]+)\/([^\/]+)/)
    if (match) {
      return `${match[2]}/${match[3]}`
    }
  } catch (e) {
    // URL解析失败
  }
  return null
}

// 从URL中提取npm包信息
function extractNpmPackage(url) {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/^\/npm\/([^@\/]+)/)
    if (match) {
      return match[1]
    }
  } catch (e) {
    // URL解析失败
  }
  return null
}

// 检查GitHub仓库是否被允许
function isGitHubRepoAllowed(repo) {
  if (!repo || CONFIG.LIST_MODE === 'none') return true
  
  if (CONFIG.LIST_MODE === 'blacklist') {
    return !CONFIG.GITHUB_REPOS.blacklist.some(blockedRepo => 
      repo.toLowerCase() === blockedRepo.toLowerCase()
    )
  } else if (CONFIG.LIST_MODE === 'whitelist') {
    return CONFIG.GITHUB_REPOS.whitelist.some(allowedRepo => 
      repo.toLowerCase() === allowedRepo.toLowerCase()
    )
  }
  
  return true
}

// 检查npm包是否被允许
function isNpmPackageAllowed(packageName) {
  if (!packageName || CONFIG.LIST_MODE === 'none') return true
  
  if (CONFIG.LIST_MODE === 'blacklist') {
    return !CONFIG.NPM_PACKAGES.blacklist.some(blockedPkg => 
      packageName.toLowerCase() === blockedPkg.toLowerCase()
    )
  } else if (CONFIG.LIST_MODE === 'whitelist') {
    return CONFIG.NPM_PACKAGES.whitelist.some(allowedPkg => 
      packageName.toLowerCase() === allowedPkg.toLowerCase()
    )
  }
  
  return true
}

// 检查referer是否被允许
function isRefererAllowed(referer) {
  if (!referer || CONFIG.LIST_MODE === 'none') return true
  
  try {
    const refererHost = new URL(referer).hostname.toLowerCase()
    
    if (CONFIG.LIST_MODE === 'blacklist') {
      return !CONFIG.SITES.blacklist.some(blockedSite => 
        refererHost.includes(blockedSite.toLowerCase()) ||
        blockedSite.toLowerCase().includes(refererHost)
      )
    } else if (CONFIG.LIST_MODE === 'whitelist') {
      return CONFIG.SITES.whitelist.some(allowedSite => 
        refererHost.includes(allowedSite.toLowerCase()) ||
        allowedSite.toLowerCase().includes(refererHost)
      )
    }
  } catch (e) {
    // referer URL解析失败，允许通过
    return true
  }
  
  return true
}

// 生成错误响应
function createErrorResponse(message, status = 403) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    }
  })
}

export default async function handler(request) {
  try {
    const url = new URL(request.url)
    
    // 处理根路径请求，返回主页
    if (url.pathname === '/') {
      return Response.redirect(new URL('/index.html', request.url), 302)
    }
    
    // 构建目标URL
    const targetPath = url.pathname + url.search
    const targetUrl = `https://cdn.jsdelivr.net${targetPath}`
    
    // 如果配置为无限制模式，跳过大部分检查
    if (CONFIG.LIST_MODE === 'none' && 
        CONFIG.ALLOWED_EXTENSIONS.length === 0 && 
        CONFIG.MAX_FILE_SIZE === 0) {
      return createFastProxy(request, targetUrl)
    }
    
    // 检查文件类型
    if (!isAllowedFileType(targetUrl)) {
      return createErrorResponse('文件类型不被允许，支持类型：' + CONFIG.ALLOWED_EXTENSIONS.join(', '), 415)
    }
    
    // 检查GitHub仓库
    const githubRepo = extractGitHubRepo(targetUrl)
    if (githubRepo && !isGitHubRepoAllowed(githubRepo)) {
      return createErrorResponse(`库 ${githubRepo} 不被允许访问，请联系 ${CONFIG.CONTACT}`, 403)
    }
    
    // 检查npm包
    const npmPackage = extractNpmPackage(targetUrl)
    if (npmPackage && !isNpmPackageAllowed(npmPackage)) {
      return createErrorResponse(`npm包 ${npmPackage} 不被允许访问，请联系 ${CONFIG.CONTACT}`, 403)
    }
    
    // 检查referer
    const referer = request.headers.get('referer')
    if (!isRefererAllowed(referer)) {
      return createErrorResponse('来源站点不被允许访问，请联系 ' + CONFIG.CONTACT, 403)
    }
    
    // 构建代理请求头
    const proxyHeaders = new Headers()
    
    // 复制必要的请求头
    const allowedHeaders = [
      'accept',
      'accept-encoding',
      'accept-language',
      'cache-control',
      'user-agent'
    ]
    
    allowedHeaders.forEach(header => {
      const value = request.headers.get(header)
      if (value) {
        proxyHeaders.set(header, value)
      }
    })
    
    // 设置Host头
    proxyHeaders.set('host', 'cdn.jsdelivr.net')
    
    // 发起代理请求
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    })
    
    if (!response.ok) {
      return createErrorResponse(`上游服务器错误: ${response.status}`, response.status)
    }
    
    // 检查文件大小（如果设置了限制）
    if (CONFIG.MAX_FILE_SIZE > 0) {
      const contentLength = response.headers.get('content-length')
      const maxSize = CONFIG.MAX_FILE_SIZE * 1024 * 1024
      
      if (contentLength && parseInt(contentLength) > maxSize) {
        return createErrorResponse(`文件过大，超过${CONFIG.MAX_FILE_SIZE}MB限制，请联系 ${CONFIG.CONTACT}`, 413)
      }
      
      // 如果没有content-length头，检查实际内容大小
      if (!contentLength) {
        const responseBody = await response.arrayBuffer()
        if (responseBody.byteLength > maxSize) {
          return createErrorResponse(`文件过大，超过${CONFIG.MAX_FILE_SIZE}MB限制，请联系 ${CONFIG.CONTACT}`, 413)
        }
        
        // 使用已读取的内容创建新响应
        return createProxyResponse(responseBody, response)
      }
    }
    
    // 创建代理响应
    return createProxyResponse(response.body, response)
    
  } catch (error) {
    console.error('代理错误:', error)
    return createErrorResponse('内部服务器错误', 500)
  }
}

async function createFastProxy(request, targetUrl) {
  const proxyHeaders = new Headers([
    ['host', 'cdn.jsdelivr.net'],
    ['user-agent', request.headers.get('user-agent') || 'Mozilla/5.0'],
  ])
  
  // 只复制关键头部
  const criticalHeaders = ['accept', 'accept-encoding', 'accept-language']
  criticalHeaders.forEach(header => {
    const value = request.headers.get(header)
    if (value) proxyHeaders.set(header, value)
  })
  
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: proxyHeaders,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  })
  
  if (!response.ok) {
    return createErrorResponse(`上游服务器错误: ${response.status}`, response.status)
  }
  
  // 快速响应头处理
  const responseHeaders = new Headers()
  
  // 只复制必要的响应头
  const essentialHeaders = ['content-type', 'content-length', 'etag', 'last-modified']
  essentialHeaders.forEach(header => {
    const value = response.headers.get(header)
    if (value) responseHeaders.set(header, value)
  })
  
  // 设置缓存和CORS
  responseHeaders.set('cache-control', `public, max-age=${CONFIG.CACHE_MAX_AGE}`)
  responseHeaders.set('access-control-allow-origin', '*')
  responseHeaders.set('x-content-type-options', 'nosniff')
  
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  })
}

// 创建代理响应
function createProxyResponse(body, originalResponse) {
  const responseHeaders = new Headers()
  
  // 复制响应头
  const allowedResponseHeaders = [
    'content-type',
    'content-encoding',
    'content-disposition',
    'etag',
    'last-modified',
  ]
  
  allowedResponseHeaders.forEach(header => {
    const value = originalResponse.headers.get(header)
    if (value) {
      responseHeaders.set(header, value)
    }
  })
  
  // 设置缓存头
  if (CONFIG.CACHE_MAX_AGE > 0) {
    responseHeaders.set('cache-control', `public, max-age=${CONFIG.CACHE_MAX_AGE}`)
  }
  
  // CORS头
  responseHeaders.set('access-control-allow-origin', '*')
  responseHeaders.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  responseHeaders.set('access-control-allow-headers', 'Origin, X-Requested-With, Content-Type, Accept')
  
  // 安全头
  responseHeaders.set('x-content-type-options', 'nosniff')
  responseHeaders.set('x-frame-options', 'DENY')
  
  return new Response(body, {
    status: originalResponse.status,
    headers: responseHeaders,
  })
}
