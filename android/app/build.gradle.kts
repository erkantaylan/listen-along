plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release version from the tag CI builds, `android-vX.Y.Z` (ANDROID_RELEASE_TAG):
// versionName X.Y.Z, versionCode X*10000 + Y*100 + Z, so every later tag installs
// over the one before. Without a tag (local builds): code 1, a "-dev" name.
val releaseTag: String? = providers.environmentVariable("ANDROID_RELEASE_TAG").orNull?.trim()?.ifEmpty { null }
val releaseVersion: Triple<Int, Int, Int>? = releaseTag?.let { tag ->
    val m = Regex("""android-v(\d+)\.(\d{1,2})\.(\d{1,2})""").matchEntire(tag)
        ?: throw GradleException("ANDROID_RELEASE_TAG must look like android-vX.Y.Z with Y and Z under 100")
    val (x, y, z) = m.destructured
    Triple(x.toInt(), y.toInt(), z.toInt())
}

// Release signing comes only from the environment (see android/README.md);
// without it assembleRelease still works and leaves an unsigned APK.
val keystorePath: String? = providers.environmentVariable("ANDROID_KEYSTORE_PATH").orNull?.ifEmpty { null }
val keystorePassword: String? = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull?.ifEmpty { null }
val keyAliasName: String = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull?.ifEmpty { null } ?: "listen-along"

// The sign-in redirect registered for the listen-along client at the central
// login is com.etaylan.listen:/oauth2redirect, the same for debug and release
// (it is not the applicationId). The manifest's intent filter and the code
// (BuildConfig.AUTH_REDIRECT_SCHEME, core/auth/AuthFlow) both take it from here.
val authRedirectScheme = "com.etaylan.listen"

// Release builds sign in through an https App Link instead when the server is
// the production one: https://<authAppLinkHost>/auth/mobile/callback, verified
// by Android against https://<authAppLinkHost>/.well-known/assetlinks.json
// (the release key's fingerprint; backend/src/mobileAuth.js). The intent
// filter is in src/release/AndroidManifest.xml (release only: a debug build is
// signed with the debug key and never verified for this host, so it keeps the
// custom scheme). core/auth/AuthFlow.redirectFor picks one per sign-in.
val authAppLinkHost = "music.etaylan.com"

android {
    namespace = "com.erkantaylan.listenalong"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.erkantaylan.listenalong"
        minSdk = 26
        targetSdk = 36
        versionCode = releaseVersion?.let { (x, y, z) -> x * 10000 + y * 100 + z } ?: 1
        versionName = releaseVersion?.let { (x, y, z) -> "$x.$y.$z" } ?: "0.2.0-dev"
        manifestPlaceholders["authRedirectScheme"] = authRedirectScheme
        buildConfigField("String", "AUTH_REDIRECT_SCHEME", "\"$authRedirectScheme\"")
        manifestPlaceholders["authAppLinkHost"] = authAppLinkHost
        buildConfigField("String", "AUTH_APP_LINK_HOST", "\"$authAppLinkHost\"")
        // The only test device is arm64; emulators on this machine are x86_64.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    if (keystorePath != null && keystorePassword != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
            buildConfigField("boolean", "AUTH_APP_LINKS", "false")
        }
        release {
            buildConfigField("boolean", "AUTH_APP_LINKS", "true")
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfigs.findByName("release")?.let { signingConfig = it }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        // android.util.Log and friends return defaults instead of throwing in
        // JVM unit tests.
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    debugImplementation(libs.androidx.ui.tooling)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.session)
    implementation(libs.androidx.media3.datasource.okhttp)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
