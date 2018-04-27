const path = require('path');
const Koa = require('koa');
const staticCache = require('../');


const port = 3003;
const app = new Koa();

app.use(async(ctx, next) => {
  let start = Date.now();
  await next();
  let ms = Date.now() - start;
  // console.log(`X-Response-Time: ${ms}ms`);
  ctx.set('X-Response-Time', `${ms}ms`);
});

app.use(staticCache(path.resolve(__dirname, '..'), {
  gzip: true,
  preload: true,
  buffer: false,
  dynamic: true,
  filter: function (filePath) {
    return !/^node_modules\/.*$/.test(filePath);
  },
  alias: {
    '/': '/index.js'
  }
}));


app.use((ctx, next) => {
  console.log('middleware after koa-custom-proxy');
})

app.listen(port);
console.log(`start server: http://127.0.0.1:${port}`);