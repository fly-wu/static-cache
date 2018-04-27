var crypto = require('crypto')
var fs = require('mz/fs')
var zlib = require('mz/zlib')
var path = require('path')
var mime = require('mime-types')
var createError = require('http-errors')
var compressible = require('compressible')
var readDir = require('fs-readdir-recursive')
var L = require('format-logger')('koa-static-cache')

class StaticCache {
  constructor(dir, options, files) {
    if (typeof dir === 'object') {
      files = options
      options = dir
      dir = null
    }

    options = options || {}
    // prefix must be ASCII code
    options.prefix = (options.prefix || '').replace(/\/*$/, '/')
    let filesMap = files || options.files || {}
    dir = dir || options.dir || process.cwd()
    dir = path.normalize(dir)
    options.gzip = !!options.gzip
    let filePrefix = path.normalize(options.prefix.replace(/^\//, ''))

    // option.filter
    // default file filter
    var fileFilter = function() {
      return true
    }
    // if options.filter is array
    if (Array.isArray(options.filter)) {
      fileFilter = function(file) {
        return ~options.filter.indexOf(file)
      }
    }
    // if options.filter is function
    if (typeof options.filter === 'function') {
      fileFilter = options.filter
    }

    if (options.preload !== false) {
      readDir(dir).filter(fileFilter).forEach((name) => {
        this.loadFile(name, dir, options, filesMap)
      })
    }

    if (options.alias) {
      for (let key in options.alias) {
        let target = options.alias[key];
        if (filesMap.hasOwnProperty(target)) {
          filesMap[key] = filesMap[target];
          L(`alias from ${key} to ${target}`);
        }
      }
    }

    L(`file list in dir: ${dir}, prefix: ${options.prefix}`);
    for (let key in filesMap) {
      L(key);
    }

    this.dir = dir;
    this.options = options;
    this.filesMap = filesMap;
    this.filePrefix = filePrefix;
  }

  safeDecodeURIComponent(text) {
    try {
      return decodeURIComponent(text)
    } catch (e) {
      return text
    }
  }

  /**
   * load file and add file content to cache
   *
   * @param {String} name
   * @param {String} dir
   * @param {Object} options
   * @param {Object} files
   * @return {Object}
   * @api private
   */
  loadFile(name, dir, options, filesMap) {
    var pathname = path.normalize(path.join(options.prefix, name))
    if (!filesMap.hasOwnProperty(pathname)) {
      filesMap[pathname] = {};
    }
    var obj = filesMap[pathname];
    var filename = obj.path = path.join(dir, name)
    try {
      var stats = fs.statSync(filename)
      var buffer = fs.readFileSync(filename)
    } catch (err) {
      throw createError(400, 'file not found');
    }

    obj.cacheControl = options.cacheControl
    obj.maxAge = obj.maxAge ? obj.maxAge : options.maxAge || 0
    obj.type = obj.mime = mime.lookup(pathname) || 'application/octet-stream'
    obj.mtime = stats.mtime
    obj.length = stats.size
    obj.md5 = crypto.createHash('md5').update(buffer).digest('base64')

    if (options.buffer) {
      obj.buffer = buffer
    }

    buffer = null
    return obj
  }

  getMiddleWare() {
    return async(ctx, next) => {
      let options = this.options;

      // only accept HEAD and GET
      if (ctx.method !== 'HEAD' && ctx.method !== 'GET') {
        return await next()
      }
      // check prefix first to avoid calculate
      if (ctx.path.indexOf(options.prefix) !== 0) {
        return await next()
      }

      // decode for `/%E4%B8%AD%E6%96%87`
      // normalize for `//index`
      var filename = path.normalize(this.safeDecodeURIComponent(ctx.path))
      var file = this.filesMap.hasOwnProperty(filename) ? this.filesMap[filename] : null;

      // try to load file if not exist in filesMap
      if (!file) {
        // options.dynamic: dynamic load file which not cached on initialization
        if (!options.dynamic) {
          return await next()
        }
        // not show hidden file
        if (path.basename(filename)[0] === '.') {
          return await next()
        }
        // remove path.sep, as the result of fs-readdir-recursive is a relative path
        if (filename.charAt(0) === path.sep) {
          filename = filename.slice(1)
        }

        // trim prefix
        if (options.prefix !== '/') {
          if (filename.indexOf(this.filePrefix) !== 0) {
            return await next()
          }
          filename = filename.slice(this.filePrefix.length)
        }

        var fullpath = path.join(this.dir, filename)
        // this.filesMap that can be accessd should be under options.dir
        if (fullpath.indexOf(this.dir) !== 0) {
          return await next()
        }

        var s
        try {
          s = await fs.stat(fullpath)
        } catch (err) {
          return await next()
        }
        if (!s.isFile()) return await next()

        file = this.loadFile(filename, this.dir, options, this.filesMap)
      } else {
        if (!file.buffer) {
          var stats = await fs.stat(file.path)
          if (stats.mtime > file.mtime) {
            file.mtime = stats.mtime
            file.md5 = null
            file.length = stats.size
          }
        }
      }

      ctx.status = 200

      if (options.gzip) {
        ctx.vary('Accept-Encoding')
      }

      ctx.response.lastModified = file.mtime
      if (file.md5) {
        ctx.response.etag = file.md5
      }

      if (ctx.fresh) {
        return ctx.status = 304
      }

      ctx.type = file.type
      ctx.length = file.zipBuffer ? file.zipBuffer.length : file.length
      ctx.set('cache-control', file.cacheControl || 'public, max-age=' + file.maxAge)
      if (file.md5) {
        ctx.set('content-md5', file.md5)
      }

      if (ctx.method === 'HEAD') {
        return
      }

      var acceptGzip = ctx.acceptsEncodings('gzip') === 'gzip'

      if (file.zipBuffer) {
        if (acceptGzip) {
          ctx.set('content-encoding', 'gzip')
          ctx.body = file.zipBuffer
        } else {
          ctx.body = file.buffer
        }
        return
      }

      var shouldGzip = options.gzip &&
        file.length > 1024 &&
        acceptGzip &&
        compressible(file.type)

      if (file.buffer) {
        if (shouldGzip) {
          var gzFile = this.filesMap[filename + '.gz']
          if (options.usePrecompiledGzip && gzFile && gzFile.buffer) { // if .gz file already read from disk
            file.zipBuffer = gzFile.buffer
          } else {
            file.zipBuffer = await zlib.gzip(file.buffer)
          }
          ctx.set('content-encoding', 'gzip')
          ctx.body = file.zipBuffer
        } else {
          ctx.body = file.buffer
        }
        return
      }

      var stream = fs.createReadStream(file.path)

      // update file hash
      if (!file.md5) {
        var hash = crypto.createHash('md5')
        stream.on('data', hash.update.bind(hash))
        stream.on('end', function() {
          file.md5 = hash.digest('base64')
        })
      }

      ctx.body = stream
      // enable gzip will remove content length
      if (shouldGzip) {
        ctx.remove('content-length')
        ctx.set('content-encoding', 'gzip')
        ctx.body = stream.pipe(zlib.createGzip())
      }
    }
  }
}

module.exports = StaticCache;

// function FileManager(store) {
//   if (store && typeof store.set === 'function' && typeof store.get === 'function') {
//     this.store = store
//   } else {
//     this.map = store || Object.create(null)
//   }
// }

// FileManager.prototype.get = function(key) {
//   return this.store ? this.store.get(key) : this.map[key]
// }

// FileManager.prototype.set = function(key, value) {
//   if (this.store) return this.store.set(key, value)
//   this.map[key] = value
// }