/**
 * 非 Next 进程（worker、CLI 脚本）加载 .env*，与 Next 的规则一致。
 * 必须作为入口文件的第一个 import。
 */
import nextEnv from '@next/env'
import { installProxyFromEnv } from './proxy'

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')
installProxyFromEnv()
