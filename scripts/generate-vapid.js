#!/usr/bin/env node
/**
 * Генерация VAPID ключей для push-уведомлений
 * Запуск: node scripts/generate-vapid.js
 */

const webpush = require('web-push');

const vapidKeys = webpush.generateVAPIDKeys();

console.log('\n=== VAPID ключи для push-уведомлений ===\n');
console.log('Добавьте эти строки в ваш .env файл:\n');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log('\n=========================================\n');
