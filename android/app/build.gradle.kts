plugins {
    id("com.android.application")
}

/*
 * 壳很薄：一个 Activity、一个 WebView、一个 JS 桥。用 Java 而不是 Kotlin，
 * 是为了少一个编译器和一套版本兼容表——这几百行代码不值得为此多拉 100MB 的依赖。
 * 网页部分由仓库根目录的 `npm run build:app` 生成到 src/main/assets/www/。
 */
android {
    namespace = "com.focussession.app"
    compileSdk = 36
    // 本机 SDK 里装的是这个版本；不写的话 AGP 会去下它自己默认的那个
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.focussession.app"
        // WebViewAssetLoader、adaptive icon、MediaStore.Downloads 分别要 21 / 26 / 29；
        // 26 起图标只需要一份 XML，29 以下的「保存到下载」退回分享
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.3.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }
}

/*
 * 网页产物由仓库根目录的 `npm run build:app` 生成。挂到 preBuild 上，
 * 免得改了 TypeScript 忘了重新打包、装到手机上的还是旧页面。
 * 声明了输入输出，源码没变时 Gradle 会跳过它。
 */
val repoRoot = rootProject.projectDir.parentFile
val buildWeb = tasks.register<Exec>("buildWeb") {
    description = "npm run build:app → src/main/assets/www"
    group = "build"
    workingDir = repoRoot
    val npm = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"
    commandLine(npm, "run", "build:app")
    inputs.dir(repoRoot.resolve("src"))
    inputs.files(repoRoot.resolve("build.mjs"), repoRoot.resolve("package.json"))
    outputs.dir(project.file("src/main/assets/www"))
}
tasks.named("preBuild") { dependsOn(buildWeb) }

dependencies {
    // OnBackPressedDispatcher：Android 13+ 的预测式返回不再调 onBackPressed()
    implementation("androidx.activity:activity:1.10.1")
    // WebViewAssetLoader：把 assets 用 https://appassets.androidplatform.net 端出来，页面才有一个真实的 origin
    implementation("androidx.webkit:webkit:1.14.0")
    // FileProvider：分享导出文件
    implementation("androidx.core:core:1.16.0")
}
