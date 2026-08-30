// ここだけ環境に合わせて書き換えれば動きます。
window.APP_CONFIG = {
  // 出勤確認アプリのGAS Webアプリ デプロイURL(/exec まで)
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/XXXXXXXXXXXXXXXX/exec',
  // Code.gs の SHARED_SECRET スクリプトプロパティと同じ値にする
  SHARED_SECRET: 'PUT_THE_SAME_SHARED_SECRET_HERE',
  POSITIONS: ['ホール', 'サブ', '麺場'],
};
