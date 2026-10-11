export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  ssr: false,
  modules: ['@pinia/nuxt'],
  devtools: { enabled: false },
  devServer: { port: 4311 },
  css: ['~/assets/main.css', '~/assets/board.css'],
  runtimeConfig: {
    public: {
      apiBase: '/api/v1',
    },
  },
  nitro: {
    devProxy: {
      '/api': { target: 'http://127.0.0.1:4310/api', changeOrigin: true },
    },
  },
  app: {
    head: {
      title: 'multiplat-factory',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'color-scheme', content: 'dark' },
        { name: 'theme-color', content: '#1a1917' },
      ],
      link: [
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=B612:ital,wght@0,400;0,700;1,400&family=B612+Mono:wght@400;700&family=Big+Shoulders+Display:wght@500;600;700&display=swap',
        },
      ],
    },
  },
})
