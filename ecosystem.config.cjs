module.exports = {
  apps: [
    {
      name: "prsenceapi",
      script: "./dist/server.js",
      instances: "1",
      exec_mode: "cluster",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
