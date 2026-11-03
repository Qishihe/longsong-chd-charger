import java.io.File
import java.util.Base64

// 一个 WebView 壳：没有任何网页资源被打进 APK，只记住一个线上地址。
// 这样网站一更新，App 下次打开就是新版 —— 这也是「网站更新 App 也跟着更新」的全部原理。
plugins {
    id("com.android.application")
}

val appVersionCode = (project.findProperty("APP_VERSION_CODE") as String?)?.toIntOrNull() ?: 1
val appVersionName = (project.findProperty("APP_VERSION_NAME") as String?) ?: "1.0.0"
val appUrl = (project.findProperty("APP_URL") as String?) ?: "https://chd-charge.pages.dev/"
val appHost = (project.findProperty("APP_HOST") as String?) ?: "chd-charge.pages.dev"

android {
    namespace = "cn.edu.chd.charge"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.edu.chd.charge"
        minSdk = 26          // Android 8.0：自适应图标、现代 WebView、SW 全部就位
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        // 入口地址写进 BuildConfig，MainActivity 只读常量，不散落在代码里
        buildConfigField("String", "APP_URL", "\"$appUrl\"")
        buildConfigField("String", "APP_HOST", "\"$appHost\"")

        resourceConfigurations.addAll(listOf("zh", "en"))
    }

    signingConfigs {
        // CI 把 keystore 以 base64 塞进环境变量，这里落盘再用。
        // ⚠️ 签名必须固定：换了签名，新包**装不上**覆盖旧包，只能先卸载（数据全清）。
        val b64 = System.getenv("KEYSTORE_BASE64")
        if (!b64.isNullOrBlank()) {
            create("release") {
                val ks = File(System.getProperty("java.io.tmpdir"), "chd-release.keystore")
                // MimeDecoder 容忍换行 —— 从网页上复制 base64 很容易带进折行
                ks.writeBytes(Base64.getMimeDecoder().decode(b64.trim()))
                storeFile = ks
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS") ?: "chdcharge"
                keyPassword = System.getenv("KEY_PASSWORD") ?: System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // 壳本身只有几百行，混淆没有收益，反而多一处出错的地方
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 没配 release 密钥就退回 debug 签名：能装、能测，但不能覆盖升级正式包
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    // 只为一个东西引入 AndroidX：AppCompatActivity 的 DayNight 主题与 insets 兼容层。
    // WebView 全屏显示，不需要 Material、RecyclerView 那些。
    implementation("androidx.appcompat:appcompat:1.7.0")

    // 🔴 appcompat 1.7.0 会拖进 kotlin-stdlib-jdk8 1.6.21，与另一路来的 kotlin-stdlib 1.8.22
    // 撞在 kotlin.collections.jdk8.CollectionsJDK8Kt 上 → :app:checkReleaseDuplicateClasses 直接红。
    // 用 kotlin-bom 把这一族整体对齐（1.8 起 jdk7/jdk8 已是空壳，只剩 stdlib 本体，重复就消失了）。
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:1.8.22"))
}
