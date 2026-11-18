const handler = require('../server');

module.exports = (req, res) => {
  const route = req.query?.route || '';
  const query = new URLSearchParams(req.query || {});
  query.delete('route');
  req.url = `/api/${route.replace(/^\//, '')}${query.toString() ? `?${query}` : ''}`;
  return handler(req, res);
};
