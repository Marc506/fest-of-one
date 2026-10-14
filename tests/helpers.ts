import { resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { f } from './fixtures/catalog/build'
import type { CatalogFilm } from '@/resolver/tmdb'

export const FIXTURES = resolve(__dirname, 'fixtures')

export function zipFolder(dir: string): Buffer {
  const zip = new AdmZip()
  zip.addLocalFolder(dir)
  return zip.toBuffer()
}

export const quiet = () => {}

/** 小型离线片目：覆盖 Letterboxd 导出 fixture 里的片 + 同名干扰项。 */
export function miniCatalog(): CatalogFilm[] {
  return [
    f(496243, 'Parasite', '기생충', '寄生虫', 2019, 133, 'KR', 'ko', 'Comedy|Thriller|Drama', 'Bong Joon-ho', 'Song Kang-ho, Lee Sun-kyun, Cho Yeo-jeong', 'class differences, basement, rain', 8.5, 19650, 44),
    f(613302, 'Parasite', 'Parasite', null, 2019, 80, 'US', 'en', 'Horror', 'Nobody Known', 'Someone', 'parasite', 4.1, 7, 1),
    f(843, 'In the Mood for Love', '花樣年華', '花样年华', 2000, 98, 'HK,FR', 'cn,zh', 'Drama|Romance', 'Wong Kar-wai', 'Tony Leung Chiu-wai, Maggie Cheung', 'qipao, corridor, hotel room, rain', 8.1, 3200, 20),
    f(1091, 'The Thing', 'The Thing', '怪形', 1982, 109, 'US', 'en', 'Horror|Mystery|Science Fiction', 'John Carpenter', 'Kurt Russell, Wilford Brimley, Keith David', 'antarctica, paranoia, shapeshifting', 8.1, 7400, 40),
    f(60935, 'The Thing', 'The Thing', '怪形前传', 2011, 103, 'US', 'en', 'Horror|Science Fiction', 'Matthijs van Heijningen Jr.', 'Mary Elizabeth Winstead, Joel Edgerton', 'antarctica, prequel', 6.3, 3000, 25),
    f(25538, 'Yi Yi', '一一', '一一', 2000, 173, 'TW,JP', 'zh,ja,en', 'Drama', 'Edward Yang', 'Wu Nien-jen, Elaine Jin, Jonathan Chang', 'family, taipei, wedding, camera', 8.0, 900, 12),
    f(1398, 'Stalker', 'Сталкер', '潜行者', 1979, 162, 'SU', 'ru', 'Science Fiction|Drama', 'Andrei Tarkovsky', 'Alexander Kaidanovsky, Anatoly Solonitsyn, Nikolai Grinko', 'zone, water, long take', 8.1, 2600, 18),
    f(251, 'Ghost', 'Ghost', '人鬼情未了', 1990, 127, 'US', 'en', 'Fantasy|Drama|Romance|Thriller', 'Jerry Zucker', 'Patrick Swayze, Demi Moore, Whoopi Goldberg', 'pottery, afterlife', 7.2, 5600, 30),
    f(9000900, 'Ghost', 'Ghost', null, 1990, 95, 'GB', 'en', 'Horror', 'Unknown Maker', 'Somebody', 'ghost', 7.0, 3800, 2),
    f(146, 'Crouching Tiger, Hidden Dragon', '臥虎藏龍', '卧虎藏龙', 2000, 120, 'TW,CN,HK,US', 'zh', 'Adventure|Drama|Action|Romance', 'Ang Lee', 'Chow Yun-fat, Michelle Yeoh, Zhang Ziyi', 'martial arts, sword, bamboo forest', 7.4, 3500, 30),
    f(30020, 'Taste of Cherry', 'طعم گيلاس', '樱桃的滋味', 1997, 99, 'IR', 'fa', 'Drama', 'Abbas Kiarostami', 'Homayoun Ershadi', 'car, suicide, hills', 7.4, 400, 8),
    f(32202, 'A City of Sadness', '悲情城市', '悲情城市', 1989, 157, 'TW', 'zh,ja', 'Drama|History', 'Hou Hsiao-hsien', 'Tony Leung Chiu-wai, Hsin Shu-fen, Jack Kao', 'taiwan, 228 incident, family', 7.6, 160, 6),
  ]
}
