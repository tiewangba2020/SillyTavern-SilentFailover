import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',workers:1,timeout:90000,expect:{timeout:15000},use:{baseURL:'http://127.0.0.1:8017',headless:true,viewport:{width:1440,height:1000},screenshot:'only-on-failure',trace:'retain-on-failure'},reporter:[['list'],['html',{open:'never'}]]});
