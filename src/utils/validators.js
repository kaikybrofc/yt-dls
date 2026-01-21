function isYoutubeLink(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}

function isValidRequestId(requestId) {
  return /^[a-zA-Z0-9_-]+$/.test(requestId);
}

module.exports = {
  isYoutubeLink,
  isValidRequestId,
};
