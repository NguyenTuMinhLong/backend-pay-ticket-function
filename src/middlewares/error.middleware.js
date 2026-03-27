function errorHandler(err, req, res, next) {
  console.error(err);

  const statusCode = err?.status || err?.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal server error',
    detail: err.details || err.detail || null,
    code: err.code || null,
  });
}

module.exports = errorHandler;
