// 这是一个故意过期的产物，用来测试 workflow 能否自动回填
// 如果 workflow 正常工作，推上去几秒后这个文件会被自动替换成真正的构建产物
export default { fetch(){ return new Response('stale') } }
